# 六语义微内核（V0.5）

> CharacterLife 的底层现在是一个零依赖的微内核：`src/kernel/`。
> 陪伴角色（聊天、关系、QQ/OneBot/酒馆适配）、文字箱庭里的自主角色、
> 以及独立仓库里的 Free Roam 斗场角色，都是建在它上面的扩展。

## 1. 一个角色 = 六个语义槽 + 一条提议—裁决通道

```
                         AgentCore（src/kernel/agent.ts）
 ┌──────────────┬──────────────┬──────────────┬──────────────┬──────────────┬──────────────┐
 │ self         │ situation    │ observation  │ memory       │ motivation   │ affordance   │
 │ SelfSlot     │ SituationStore│ ObservationLog│ MemoryStore │ MotivationSlot│ AffordanceRegistry│
 │ 只读人格     │ 由观察推出的 │ 只追加的感知 │ 带出处的记忆 │ 内驱力 / 目标│ 各扩展登记的 │
 │ + 身心状况   │ 处境信念     │ 流（带可信度）│ + 关系认识   │ / 承诺账本   │ 可行动作     │
 └──────────────┴──────────────┴──────────────┴──────────────┴──────────────┴──────────────┘
                                   │ 所有持久状态的改变
                                   ▼
                    submitProposals → PolicyEngine（能力 × 路径 × 规则）→ 审计（带语义标签）
```

六类是**领域语义**，不是六个服务：它们共用一个状态存储与一个裁决通道。
语义的作用是给每一条可写状态一个明确的归属（`semanticOf`），让权限、审计与 Mind 的输入都能按语义组织。

| 可写路径 | 语义 | 说明 |
|---|---|---|
| `profile.*` | self | 只读人格，需要 `profile:write` |
| `dynamic.mood.* / activity.* / energy` | self | 身心状况 |
| `dynamic.goals / drives.* / doNotDisturbUntilSim / lastDecisionAtSim` | motivation | 目标、内驱力、自己接受的约束 |
| `relationship.*` | memory | 关系是对他人的记忆与认识 |
| `memory.*` | memory | |
| `timeline.*` | situation | 已知的未来事件 |
| `policy.*` | governance | 不属于心智语义 |

有测试逐条核对：白名单里的每一条路径都必须有归属，每条审计记录都带 `semantic`。

## 2. 槽各自的纪律

- **Self**：人格深冻结；身心状况只能经提议改变。将来的「自我模型」也会落在这里，经反思证据 + Policy 晋升。
- **Situation**：是**信念**，不是世界真值的镜像。只在收到新观察时更新，中间可能过时。
- **Observation**：除 `runtime` 来源外默认不可信，只能进数据区。陪伴角色的用户消息、箱庭的世界观察都进这里。
  观察不是记忆：哪些值得记住由消费方按显著性决定。
- **Memory**：带来源、时间、认识论状态（fact / speculation / fiction）。世界记忆只能来自 `runtime_event`。
- **Motivation**：驱力只有运行时能写、只在世界确认成功时缓解；承诺的**当前状态**在这里，**历史证据**在 Memory。
  承诺只能结算一次。
- **Affordance**：各扩展登记 provider（陪伴：对话五动作；箱庭：世界动作清单 ∩ 处境信念）。
  清单是「可以提议什么」，成败由准入闸门与世界决定。

## 3. 自主循环与多角色宿主

```
AgentHost.tick()
  ├─ WorldDriver.step()          世界推进：结算动作、产生观察（TextWorld / Godot / 斗场）
  ├─ hooks.beforeAgents()        实验干预、导演事件
  ├─ for agent in order:         固定顺序或轮转（避免永远先手）
  │    AutonomyRunner.step()
  │      bridge.sync()           世界 → Memory / Motivation / Observation / Situation
  │      decideWake()            纯函数：不醒就不调用模型
  │      Mind.decide(六语义快照) 规则 / LLM（可录制回放）
  │      admitWorldIntents → WorldService.admit()
  └─ clock.advance(tickMs)
```

胜负、回合、谁能听见谁 —— 都是**世界规则**，由 `WorldDriver` 实现，不进内核。
Free Roam 的斗场「宪法」会作为一个 WorldDriver 接进来。

## 3.5 完整性层（V0.6 · 宪法 K1–K6）

认知层回答"角色怎么想、怎么做"，完整性层回答"它经历过的事，事后能不能被信任"。
两层都在 `src/kernel/`，完整性层在 `src/kernel/integrity/`，条文见 [`CONSTITUTION.md`](CONSTITUTION.md)。

- `AgentCore({ integrity })`：每条审计事件镜像进哈希链账本，带身份指纹；人设替换写身份修订；
- 自主循环：准入的动作登记为**意图**；世界回执与观察由世界**权威**签发为**事实**；LLM 原始输出入账；
- 陪伴角色：恢复流程从 SQLite 的 `ledger` 表恢复账本并核对，断链写进恢复报告；
- 世界层（Free Roam）：用 K4 种子流、K5 封存、K6 预先登记实现心声分级与挑局。

## 4. 边界（有测试断言）

- `src/kernel/**` 只 import 自己和 `node:` 内置模块；
- `src/kernel/world/**` 不 import memory / agent / cycle / semantics（世界协议无法改写角色状态）；
- 外部项目只从 `src/kernel/index.ts` import。

陪伴扩展的位置不变（`src/runtime`、`src/conversation`、`src/adapters`、`src/api`、`src/character`、
`src/persistence` …），它们现在 import 内核。`CharacterWorkspace extends AgentCore`，
旧的快照格式、SQLite 事件日志与重放全部兼容（测试覆盖）。

## 5. 给 Free Roam（独立仓库）的接入方式

Node 的类型擦除**不处理 `node_modules` 里的 .ts 文件**，所以内核暂时不能作为 npm 依赖直接安装使用。两个可选方案：

1. **git submodule（推荐，零构建）**：把 CharacterLife 作为子模块放在 `vendor/characterlife`，
   从 `vendor/characterlife/src/kernel/index.ts` import。内核零依赖，子模块不需要安装任何东西。
2. 以后需要发包时，再给内核加一个 `tsc` 构建产物（`dist/kernel`），改为普通 npm 依赖。

## 6. 尚未做的（等宪法）

- 多角色之间的关系：现在的 `relationship` 是「对主要对象（陪伴场景的用户）」的单一关系；
  斗场需要按对象分开的关系认识（`relations[agentId]`），形状等宪法确定后再加。
- 角色之间说话：由世界投递成对方的 `agent` 来源观察（谁能听见是世界规则）。
- 心声可见性（public / private / 稍后揭晓）与罐主的特殊观察权限：由日志与 Policy 能力实现，接口待定。
- 「我知道自己是 agent」的元认知层：Self 槽的第二层，待角色设定确定。
