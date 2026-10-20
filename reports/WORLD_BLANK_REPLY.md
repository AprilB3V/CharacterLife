# P1 复现记录：`deepseek-flash` 多轮带历史返回空白

> 状态：**原因已定位，本轮不修**。修复建议见 §4，需要单独一轮改动（涉及上下文历史形态，不适合与 P0 混在一起）。
> 复现脚本：[`experiments/real-model/blank-reply-probe.ts`](../experiments/real-model/blank-reply-probe.ts)（`npm run real:blank`）

## 1. 现象

实机联调中，第二轮之后的追问偶尔只拿到降级台词
「嗯……刚才那句我没接住。你再说一遍，好吗？」。
`ConversationService` 的降级条件是 `reply.trim().length === 0`，审计里记为 `provider_error`。
在 16:31–16:33 的四次调用里出现过四次空白（`19` 个空格，`finish_reason=stop`）。

## 2. 复现方法

同一份 system（真实 `buildSystemPrompt` + 世界清单 + 未确认动作）、同一个问题，
只改「历史里 assistant 那一轮长什么样」：

| 组 | 历史 |
|---|---|
| A | 无历史 |
| B | 自然语言：`可以。我去看看。` |
| C | JSON 信封：`{"reply":"可以。我去看看。","proposals":[],"memoryWrites":[],"worldActions":[…]}` |

```bash
set "DEEPSEEK_API_KEY=..."
set "PROBE_REPEAT=3"
node experiments/real-model/blank-reply-probe.ts "最近工作累不累？"
```

## 3. 结果

问题「最近工作累不累？」（短句，可与联调时那几次空回复对齐）：

| 组 | 空白 / 总次数 | 原始长度 |
|---|---|---|
| A 无历史 | **0 / 3** | 正常 JSON |
| B 自然语言历史 | **3 / 3** | 34 / 60 / 59，全是空白字符 |
| C JSON 信封历史 | **0 / 3** | 正常 JSON |

长句「你到桌边了吗？那边怎么样？」在同一脚本下是 `0/4`（三组都正常）——
说明触发条件是「**短问题 + 历史里 assistant 不是合法 JSON**」的组合，而不是单看历史形态。

## 4. 原因判断

请求带了 `response_format = {"type":"json_object"}`，历史里的 assistant 轮却是自然语言。
模型在「必须输出 JSON」和「上一轮我说的是普通文本」之间出现冲突，
最终输出纯空白（`finish_reason=stop`，不是截断，也不是报错）。

证据支持：
- 换成长句（模型有更多话可说）时不再出现 → 不是网络/鉴权/配额问题；
- 换成 JSON 信封历史后 0/3 → 与「历史是否是合法 JSON」强相关；
- 原始长度 34/60/59 全是空白字符 → 不是被截断的半个 JSON。

## 5. 最小修复建议（未实施）

按代价从低到高，建议先做第 1 条：

1. **让历史与响应契约一致**：在 `buildMessages` / `ContextManager` 组装历史时，
   把 assistant 轮的 content 包成 `{"reply": "..."}`
   （或直接存当轮的完整信封）。改动点集中在 `src/conversation/context.ts` 与
   `src/context/manager.ts`，预计 15–30 行，并且只影响发给 Provider 的历史视图，
   不改存储、不改 Mock。
2. **一次重试**：检测到 `text.trim() === ''` 时，用「历史包成 JSON」的形态重发一次
   （失败再降级到现有台词）。成本：偶发多一次调用，收益：演示与线上都不再出现空气泡。
3. **不建议**：换模型、改 maxTokens、大规模重写 Provider —— 与已定位的原因无关。

## 6. 影响评估

- 不谎报：空白 → 降级台词，不会产生错误的世界声明，安全性上没有新增风险。
- 体验：偶发一次「没接住」，需要用户重说。`world:say` 提供 `CL_NEW_SESSION=1` 作为临时绕过。
- 与 P0 无关：空白不会写记忆，也不会触发世界动作。
