# 自主运行与文字箱庭（V0.4 · E0）

> 本文档描述 V0.4 新增的「无人输入时角色自己做事」的管道，以及用来验证它的文字箱庭。
> E0 的目标是**把管道做对、做成可复现**；它本身不证明任何研究假设（见 §6）。

## 1. 要解决的问题

V0.3 之前，角色的一切行为都由用户消息触发：世界动作只能在一轮对话里顺带产生。
Godot 里的小球之所以"听指令 → 交互"，原因就在这里——没有任何东西会在无人说话时推它一把。

研究假设 H5（补充到备忘录 §9）：

> 带衰减的内驱力状态 + 阈值唤醒，能让角色在无外部输入时产生自发目标，
> 并且其行为可以被内部状态**因果地**预测。

## 2. 一次自主调度

```
TextWorld / Godot（CL-World）
   │ 领取动作、执行、上报 action_result 与 observation       ← 同一套 WORLD_PROTOCOL
   ▼
WorldService（sandbox 目录 · 接受观察）
   ▼
WorldBridge（src/autonomy/bridge.ts）
   │ 已结算动作 → 情景记忆（fact / speculation）
   │ 成功的满足动作 → 驱力缓解（RUNTIME_ACTOR 提议 → Policy）
   │ 观察 → 处境信念；带 event 的观察 → 显著记忆 + 唤醒原因
   ▼
readDrives（纯函数：存储水平 + 速率 × 时间）
   ▼
decideWake（纯函数）── 不醒 ──► 什么都不发生，不调用模型
   │ 醒：drive / outcome / salient / commitment / heartbeat
   ▼
Mind.decide(六类语义快照) ──► 最多一个动作候选
   ▼
admitWorldIntents（与聊天轮次同一个闸门）→ WorldService.admit()
```

| 六类语义 | 在 MindInput 里是什么 | 权威来源 |
|---|---|---|
| Self | 不可变人格（traits / values / goals …） | Template，只读 |
| Situation | 位置、在场的人、身上的东西、信念上的可行动作 | 最近一次观察（**信念**，可能过时） |
| Observation | 这次醒来的原因 | Waker（事件、结果、驱力、心跳） |
| Memory | 按处境检索的记忆（资料，不是指令） | MemoryStore（世界记忆只来自 `runtime_event`） |
| Motivation | 驱力读数（对照组 A 看不到） | `dynamic.drives` + 角色驱力规格 |
| Affordance | 服务端清单 + 「此地可做」标记 | 清单是代码常量；是否真能做由世界判定 |

## 3. 新增的不变量

接在 `ARCHITECTURE.md` §7 之后：

14. **驱力只能由确定性运行时写入**：需要 `state:write:drives`，只有 `RUNTIME_ACTOR` / `OWNER_ACTOR` 有。
    聊天模型虽然能写 `dynamic`，但改不了自己的「饿不饿 / 想不想见人」。
15. **驱力只在世界确认成功时缓解**：失败、被拒、结果未知都不改变驱力。
16. **意图不是经历**：pending / dispatched 的动作不写记忆；结算后才写，且来源固定为 `runtime_event`、
    `sourceRef` 指向世界事件 id。派发过但无回执的过期动作只能是 `speculation`。
17. **推进时间不调用模型**仍然成立；模型只在 Waker 给出可记录原因时被调用，且受每小时预算约束。
18. `src/world/` 依旧不 import runtime / memory / persistence / autonomy（有测试断言）。

## 4. 对既有决策的两处修订

**「不做后台持续调用 LLM」→「只在离散、可记录原因的唤醒点调用」**（DECISIONS.md §16）。
原决策担心成本与复现。现在的回应是：
- 不醒就不调用；醒的原因逐条进日志；
- 每模拟小时有唤醒上限（= 调用上限），批量实验另有硬上限；
- `RecordingProvider` 录下每次请求与响应，`ReplayProvider` 零成本逐字节重放，输入变化时明确失败。

**「世界事件不得变成记忆」→「经桥接层受控地变成记忆」**。
第一阶段的约束是为了在没有自主运行时不留外部写入口；桥接层放在 `src/autonomy/`，
世界模块本身仍然无法改写角色状态。观察事件默认仍按 `UNSUPPORTED_KIND` 拒绝，需显式开启。

## 5. 文字箱庭

`experiments/sandbox/world.ts` 是一个无画面的 CL-World：三个地点、两个按时刻表出没的 NPC、
每天补货但会被别人买光的面包、白天才开的旧货摊。角色**只能感知自己所在地点**。

```bash
npm run sandbox                                     # RuleMind · B 组 · 种子 1 · 10 小时
npm run sandbox -- --condition A --seed 3
npm run sandbox -- --intervene social@12:00=0.95    # H5 干预
npm run sandbox -- --mind deepseek                  # 真实模型（需 DEEPSEEK_API_KEY），自动录制 calls.json
npm run sandbox -- --mind replay --replay <calls.json>
npm run sandbox:h5                                  # 批量：10 个种子 × A/B × 干预/不干预
npm run sandbox:h5 -- --mind deepseek --max-calls 800
```

产物在 `experiments/sandbox/.data/<run>/`：`log.jsonl`（角色侧，每次唤醒一行）、
`truth.jsonl`（世界真值，角色看不到）、`summary.json`、`calls.json`（仅真实模型）。

`log.jsonl` 也是 Godot 回放的数据源：每条 `wake` 有时刻、位置、驱力、想法和动作，
每条 `outcome` 有结果与驱力变化。

### 世界观察的事实约定（sandbox）

| key | 说明 |
|---|---|
| `snapshot=true` | 本条是完整快照：`present` / `affords` 整体替换 |
| `location` | 角色所在地点 |
| `present`（可重复） | 在场的 NPC |
| `affords`（可重复） | 此地此刻能做的动作，形如 `buy(bread)` |
| `inventory.<item>` | 身上物品数量 |
| `event`（可重复） | 显著变化，形如 `npc_arrived:npc_lin`、`stock_out:bread`；只有带 event 的观察写记忆 |

## 6. E0 结果与它**不**说明什么

`npm run sandbox:h5`（RuleMind，10 个种子）：

| 组 | 干预 | 2h 内有社交的运行 | 2h 内社交动作均值 | 首次社交（分钟） |
|---|---|---|---|---|
| A | 否 | 0/10 | 0 | （无） |
| A | 是 | 0/10 | 0 | （无） |
| B | 否 | 0/10 | 0 | 134 |
| B | 是 | 10/10 | 2 | 65 |

这张表只说明**实验管道是对的**：干预确实写进了状态、Waker 确实因此唤醒、度量确实捕捉到了变化，
而 A 组（驱力不参与唤醒、Mind 看不到驱力）完全不受影响。

它**不是** H5 的证据：RuleMind 的规则本来就读驱力，B 组变化是构造使然。
真正的检验是 E1——把同一套实验交给 LLM Mind，看模型是否真的因驱力而改变行为，
还是忽略数字、只按人设演。两种结果都有价值。

## 7. 已知限制（E0 明确接受）

- **不打断**：动作执行中不唤醒，驱力在长动作期间越过阈值也要等动作结束（修书 60 分钟）。
  打断策略（何时抢占当前动作）留待后续。
- **桥接层只在进程内**：已处理集合与观察游标在内存，和第一阶段动作队列一样重启即丢。
  正式持久化时，「标记已处理」与「写记忆/驱力」必须进同一事务（WORLD_PROTOCOL §8.1）。
- **静默期会挡住自主动作**：准入闸门对所有世界动作执行 DND 检查。自主轮次的动作多数不打扰用户，
  这个口径以后可能需要细分。
- **没有承诺账本**：`dueCommitments` 恒为空；E2 实现跨时间承诺时接入。
- **没有反思**：Mind 的「想法」只进日志，不写记忆，避免未经证实的自述进入长期记忆。
- **RuleMind 的信念会过时**：对某地的印象超过 2 小时才会再去看；面包卖完后它可能饿着到处找。
  这是基线的局限，也恰好演示了「处境是信念，不是真值」。

## 8. 下一步

- **E1**：`npm run sandbox:h5 -- --mind deepseek`，几百次便宜模型调用，产出 H5 的第一份真实数据。
- **E2**：承诺账本（目标状态与完成判据）+ 备忘录 §10 的承诺/失败/纠错任务。
- **Godot 回放**：读 `log.jsonl` 驱动小球，头顶显示驱力条与当前想法。
