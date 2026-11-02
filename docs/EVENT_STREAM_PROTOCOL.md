# 双向事件流协议（草案）

> 状态：**草案，未实现**。来源：《CL 与 VideoCohost 架构评审》（2026-11-02）“根本问题：语音协议”。
> 本文只定协议形状与分层，不含实现；字段名在第一个实现落地前都可以改。

## 1. 为什么要换协议

现有语音链路是 Open-LLM-VTuber（下称“外壳”）负责 ASR、VAD、TTS 和话轮判断，等它认定主播说完，再把一整句文字经 OpenAI 兼容接口发给 CL，CL 回一段。一问一答的协议让下面这些机制都无处安放：

| 机制 | 需要的信息 | 现在的问题 |
|---|---|---|
| “你说完了没有” | 停顿时长、未完成的半句话 | 静音判定在外壳内部，CL 收到时截断已经发生 |
| 续想 | “还在想，新的话接到同一条思考链” | 协议里没有“未完成”状态 |
| 打断与收住 | 主播又开口了 | CL 不知道 |
| 主动开口 | 游戏事件触发吐槽 | 只能伪造 user 输入，已禁用 |

### 1.1 Open-LLM-VTuber 现状核对（2026-11-02，仅读代码，未运行）

本机副本 `应用分析/Open-LLM-VTuber`（提交 `992309c`）：

- **没有中间识别**：`asr/asr_interface.py` 只有 `transcribe_np(audio) -> str`，所有后端（faster-whisper、sherpa-onnx、FunASR、Azure 等）都是整段识别。
- **不暴露停顿时长**：`vad/silero.py` 用固定阈值判定说完（`required_misses=24`，约 0.8 秒），结果只体现为一整段音频进入 ASR。
- **开口检测不出外壳**：VAD 检测到开口时向前端发 `control: interrupt` 用于停止播放，不转发给后端 LLM。
- **主动发言是伪造输入**：`ai-speak-signal` 把 `proactive_speak_prompt` 当作 user 输入送进对话（只是不写历史）。

结论：外壳本身吐不出 `speech.partial` / `speech.pause`。按评审的分支，写一个薄的语音 adapter，把外壳降级为纯 I/O（只用它的 TTS 播放与 Live2D 前端），或不再使用。是否复用它的 VAD/ASR 模块，在 adapter 实现时再决定。

## 2. 事件

所有事件共用一个信封：

```ts
interface StreamEvent<T extends string, P> {
    type: T
    /** 单调递增，由发送方分配；接收方用它去重与排序 */
    seq: number
    /** 发送方的墙钟毫秒；只用于日志与延迟统计，不参与判定 */
    atWall: number
    /** 同一句话 / 同一次回复共享的 id */
    utteranceId?: string
    payload: P
}
```

### 2.1 进（adapter → CL runtime）

| 事件 | payload | 说明 |
|---|---|---|
| `speech.partial` | `{ text }` | 中间识别结果，可被后续 partial 覆盖 |
| `speech.pause` | `{ ms }` | 当前已静音时长；adapter 可按固定间隔重复发送，ms 递增 |
| `speech.final` | `{ text }` | ASR 认为这一段的最终文本；**不等于话轮结束**，话轮由 runtime 判定 |
| `user.interrupt` | `{}` | 主播在角色说话期间开口 |
| `world.event` | `{ ref, kind, summary, facts? }` | 游戏 / 世界事件；`ref` 指向权威事件 id，进入 Observation |

### 2.2 出（CL runtime → adapter）

| 事件 | payload | 说明 |
|---|---|---|
| `reply.start` | `{ reason: 'turn' \| 'proactive', sourceRef? }` | 开口；`proactive` 是主动开口，`sourceRef` 指向触发它的世界事件 |
| `reply.delta` | `{ text }` | 流式文本片段，adapter 送 TTS |
| `reply.yield` | `{ reason: 'done' \| 'interrupted' \| 'superseded' }` | 收住；`interrupted` 表示因 `user.interrupt` 主动让出 |

## 3. 分层

```
音频设备 / 外壳 I/O
   │  （ASR、VAD、TTS 都是可替换的实现）
语音 adapter（VideoCohost 内）      ← 只负责把信号翻成事件、把 reply.delta 送 TTS
   │  StreamEvent
CL runtime：事件队列 + 话轮判断 + 打断处理   ← 新增，Free Roam 解说同样需要“什么时候开口”
   │
ConversationService / 六语义内核（不变）
```

- **runtime 负责**：事件排序与去重；话轮判断（`speech.pause` 达到阈值且语义上完整才结束话轮，阈值可按角色配置）；续想（话轮未结束时新的 `speech.final` 并入同一轮）；打断（收到 `user.interrupt` 立即 `reply.yield('interrupted')`，已说出的部分按实际说出的内容记入对话）；主动开口（`world.event` 经现有决策逻辑判断后发 `reply.start('proactive')`，不伪造 user 输入）。
- **adapter 负责**：具体 ASR、VAD、TTS；把 TTS 实际播放到的位置回报给 runtime（用于打断时截断记录，字段待定）。
- **内核不变**：`world.event` 走现有 Observation 通道；回复仍走 `ConversationService` 的提议—裁决，不新增绕过 Policy 的写入路径。

语音 adapter 先放在 CharacterLife-VideoCohost；等 Free Roam 解说也要接 TTS 时再抽成共享包（出现第二个使用方再抽）。

## 4. 待定问题

1. 传输：同进程回调、WebSocket 还是两者都支持。倾向先做同进程接口，WebSocket 作为一层薄包装。
2. 话轮判断的“语义上完整”用规则还是小模型；先用停顿阈值 + 句末标点规则，留接口。
3. 续想与流式生成的关系：话轮未结束时是否允许预生成（投机），被新输入推翻时如何 `superseded`。
4. 打断时已播放内容的回报粒度（字符 / 时间戳）。
5. 现有 OpenAI 兼容接口（SillyTavern 等）保留为一问一答的兼容层，不强制迁移。

## 5. 落地顺序

1. 本草案评审定稿（字段名、传输方式）。
2. CL runtime 增加事件队列与话轮状态机，Mock adapter 离线测试覆盖：续想、打断、主动开口。
3. VideoCohost 写语音 adapter，决定外壳去留，实机联调。
4. 完成后《CL 优化思路》里的“适配层等你说完”才有落点。
