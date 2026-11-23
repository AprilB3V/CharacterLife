# CharacterLife · 可信 AI 角色的心智内核

> 让 AI 角色在一个持续存在的世界里**自己生活**：知道自己是谁，记得经历过什么，有自己想要的东西，
> 做的事有后果——而且它经历过的每一件事，**事后都能被任何人核对**。
>
> 模型无关、零运行时依赖、可离线复现。角色的情感与生活均为模拟，不声称具有意识或人类情感。

---

## 1. 这是什么

大多数 AI 角色只在被叫到时才存在：没有人说话，它就不存在；它说自己做过什么，就算做过什么；
它的人设、记忆与动机，都只是提示词里的一段文字，一句话就能改写。

CharacterLife（CL）把角色从提示词里拿出来，放进一个**内核**：

```
应用（扩展）     陪伴角色 · 自主箱庭 · 节目与游戏（Free Roam）
                        │  只通过 src/kernel/index.ts
                        ▼
认知层 · 六语义  Self 自我 · Situation 情境 · Observation 观察
                 Memory 记忆 · Motivation 动机 · Affordance 可行动性
                 自主循环：内驱力 → 唤醒 → Mind（规则 / 任意 LLM）→ 准入 → 世界 → 结算
完整性层 · 宪法  身份指纹 · 意图≠事实 · 哈希链账本 · 种子流 · 承诺–揭示 · 预先登记
裁决通道         一切状态变化都是提议，由权限策略裁决并留痕
```

**认知层**回答"角色怎么想、怎么做"；**完整性层**回答"它经历过的事，能不能被信任"。

## 2. 三条主张

**一、动机要有独立于语言的来源。**
内驱力是随时间变化的状态，只有确定性的运行时能写；只有世界**确认**一个动作成功，驱力才会缓解。
模型说"我吃过了"不算数。动机因此可以被干预、被测量，而不只是角色扮演出来的一句话
（研究假设 H5，见 [`docs/AUTONOMY.md`](docs/AUTONOMY.md)）。

**二、发生了什么，由世界说了算。**
模型可以想、可以说、可以提议；只有登记过的**权威**（游戏规则引擎、CL-World）能签发事实。
权威凭据是代码对象，任何对话、模型输出或世界自由文本都伪造不出它。

**三、可信任，需要可核对。**
所有影响角色的记录进入只增不改的哈希链账本：人设漂移可以检出，篡改可以定位，
随机性来自公开登记的种子，封存内容只公开校验码、到期揭示，挑选与可见性规则必须事先登记。
观众不需要相信制作方——他们可以自己算（[`docs/CONSTITUTION.md`](docs/CONSTITUTION.md)）。

## 3. 同一个内核，三种应用

| 应用 | 角色在做什么 | 状态 |
|---|---|---|
| **陪伴角色** | 跨 QQ / OneBot / SillyTavern 保持同一个人格、关系与长期记忆；会拒绝、会协商、会沉默 | 已实现（`src/runtime`、`src/conversation`、`src/adapters`） |
| **自主箱庭** | 无人输入时自己生活：饿了去找吃的、想说话了去找人，只能看见自己所在的地方 | 文字箱庭已实现（`npm run sandbox`）；2.5D 观察箱庭 CharacterLife-World（Godot）为独立实验仓库 |
| **节目与游戏** | 神话神兽在罐中博弈，心声分级、封存、到期揭晓，每局一本可核对的账本 | [Free Roam《罐中斗》](https://github.com/AprilB3V/Free-Roam) 第一期引擎已接入内核 |

## 4. 现在走到哪一步（如实标注）

| | 已验证 | 尚未验证 |
|---|---|---|
| 人格与权限 | 聊天层无法改写人格与关系；完全被说服的模型也越不过权限层（A/B 实验、Mock） | 注入检测是启发式，不承诺绝对防越狱 |
| 记忆与连续性 | 跨会话、跨进程恢复；真实 DeepSeek 下 B 组准确复述共同经历（18 次调用） | 长期大规模记忆下的检索质量 |
| 自主与动机 | 管道、干预与度量正确（规则 Mind，10 个种子，零成本） | **H5 的真实模型实验尚未运行**——规则 Mind 读驱力是构造使然，不构成证据 |
| 完整性 | 宪法每条可断言均有测试；账本可离线核对；与《罐中斗》引擎逐位兼容 | 多世界同时连接同一角色时的权威命名空间 |
| 多角色 | 宿主骨架（共享时钟、确定性顺序） | 按对象分开的关系认识；角色之间的对话投递 |

测试：`npm test` 378 项（Mock / 离线 / 确定性）；真实平台与真实模型的验证范围在各报告中单独记录，
不用模拟结果冒充真实联调。

## 5. 研究假设

| | 假设 | 状态 |
|---|---|---|
| H1 | 结构化维护目标与承诺，比对话摘要更稳定地支持长程任务 | 承诺账本已实现，待对照实验 |
| H2 | 带来源、时间与因果证据的记忆，在冲突与纠错上优于纯相似度检索 | 待对照实验 |
| H3 | 关系与自我认识的渐进更新，比一次性改人设更连续可信 | 关系里程碑已实现，自我模型待实现 |
| H4 | 有限上下文优先给目标、有效状态与高价值经历，以更低成本维持一致性 | 上下文预算已实现，待对照实验 |
| H5 | 带衰减的内驱力 + 阈值唤醒，使角色在无输入时产生可被内部状态因果预测的行为 | 管道已验证（E0），真实模型实验（E1）待运行 |

## 6. 已实现的模块

| 模块 | 文件 | 现状 |
|---|---|---|
| Conversation 聊天区 | `src/conversation/` | 上下文组装、记忆注入、结构化输出解析、边界短路、失败降级 |
| Runtime 工作区 | `src/runtime/` | 动态状态、关系、事件时间线、行为决策、里程碑、状态补丁事件 |
| Memory 记忆区 | `src/kernel/memory/` + `src/persistence/` | 四类记忆、来源与时间、检索打分、冲突检测、软删除、导出、SQLite 持久化 |
| Policy 规则权限层 | `src/kernel/policy/` | 能力模型、规则表、路径白名单、限速、注入降级、审计日志 |
| Character Persistence | `src/character/` | Template / Instance / Session 分离，版本化人格，8 步恢复 |
| Context Manager | `src/context/` | 每轮预算化组装、四阶梯压缩降级、实际用量记录 |
| **Platform Adapter（V0.2）** | `src/adapters/` | 统一 `PlatformAdapter` 协议；QQ 官方机器人 / OneBot 11 / SillyTavern 三个实现 |
| **API Gateway（V0.2）** | `src/api/` | 去重、限流、身份解析、每实例互斥、指令、本地 HTTP API |
| **Identity / 绑定（V0.2）** | `src/identity/` | 一次性绑定码（过期/限次/只存哈希），跨平台共用同一实例 |
| **World 世界交互（V0.3）** | `src/kernel/world/` + `src/api/world-routes.ts` | 模型产生动作意图（准入闸门 + 服务端清单）、HTTP 领取/回执、双去重、独立 world token、回执回灌下一轮认知；**动作队列未持久化** |
| **Autonomy 自主运行（V0.4 · E0）** | `src/kernel/cycle/` + `experiments/sandbox/` | 内驱力（只有运行时能写、只在世界确认成功时缓解）、确定性 Waker、世界→记忆受控桥、规则 Mind 与 LLM Mind（录制/回放）、无画面文字箱庭；见 [`docs/AUTONOMY.md`](docs/AUTONOMY.md) |
| **Kernel 六语义微内核（V0.5）** | `src/kernel/` | `AgentCore`：六个语义槽 + 提议—裁决通道；每条可写状态有语义归属；多角色宿主 `AgentHost`；外部项目唯一入口 `src/kernel/index.ts`；见 [`docs/KERNEL.md`](docs/KERNEL.md) |
| **Integrity 完整性层（V0.6）** | `src/kernel/integrity/` | 宪法 K1–K6：哈希链账本、身份指纹、权威与事实、种子流、承诺–揭示、预先登记；SQLite `ledger` 表；见 [`docs/CONSTITUTION.md`](docs/CONSTITUTION.md) |
| LLMProvider | `src/conversation/providers/` | `MockProvider`（离线确定性）与 `DeepSeekProvider`（真实 API） |

**不做**：自训练基座模型；声称角色有意识；为了"自主"在后台无节制地调用模型
（只在有可记录原因时唤醒，并受预算约束、可录制回放）。前端与 3D/2.5D 表现放在独立仓库。

## 7. 环境与安装

- **Node.js ≥ 22.6**（本仓库实测 Node **v26.7.0**）。利用 Node 原生的 TypeScript 类型擦除，
  **不需要编译步骤、也没有任何运行时依赖**。
- 持久化使用 Node 内置的 `node:sqlite`（实测 SQLite 3.53.4），**不需要安装任何数据库驱动**。
- `npm install` 只安装开发依赖（`typescript` 用于 `npm run typecheck`），不安装运行时依赖。

```bash
git clone <this-repo>
cd CharacterLife
npm install          # 仅 devDependencies（可选，仅类型检查需要）
```

## 8. 运行演示（无需任何 API Key）

### 8.1 虚构时间演示（内存态，单进程）

```bash
npm run demo               # 虚构时间演示：三天主线 + 一周空窗
npm run demo -- --restart  # 演示结束后关闭工作区、重新打开，验证重启恢复
npm run ab                 # A/B 对照实验（Mock，零费用）
```

### 8.2 跨会话持久化演示（SQLite，每个命令都是独立进程）

```bash
node examples/persistent-demo.ts init      # 建模板 + 建实例 + 首份快照
node examples/persistent-demo.ts chat      # 多轮对话 + 生活事件 + 保存并退出
node examples/persistent-demo.ts resume    # 新进程 + 新会话：验证人格/关系/记忆仍在
node examples/persistent-demo.ts verify    # 只做断言（失败退出码 1）
node examples/persistent-demo.ts resume --budget 1500   # 观察上下文压缩降级
```

数据在 `examples/.data/characterlife.db`（可删除重建）。这个演示是验收「上下文耗尽后的恢复」
的直接证据：`chat` 与 `resume` 是两个不同的操作系统进程。

### 8.3 人格连续性 A/B

```bash
npm run continuity   # A：纯 Prompt + 近期对话 / B：持久化人格+状态+记忆+Context Manager
```

结果写入 `reports/PERSONA_CONTINUITY.md`。

### 8.4 V0.2 跨平台（QQ / OneBot / SillyTavern）

```bash
# QQ：离线全链路（官方事件格式 + MockTransport，不需要凭证）
npm run qq:demo

# QQ：真实 Webhook 服务（需要 QQBOT_APP_ID / QQBOT_APP_SECRET）
npm run qq:server

# OneBot 11：离线全链路（OneBot 事件格式 + MockTransport，不需要网关和 QQ 号）
npm run onebot:demo

# OneBot 11：启动脚本（读 .env → 体检 → 启动；体检不过不硬启动）
.\scripts\start-onebot.cmd -Probe     # 只体检：Node/node:sqlite/配置/端口/网关
.\scripts\start-onebot.cmd            # 启动（Ctrl+C 停止）
npm run onebot:start                  # 等价别名

# OneBot 11：不用脚本时（自己注入环境变量后启动上报服务）
npm run onebot:server

# SillyTavern：启动 OpenAI 兼容 API
$env:CHARACTERLIFE_API_TOKEN = "local-dev-token-123"
npm run st:server          # 输出里直接给出酒馆要填的 Base URL 与 Key

# SillyTavern：按酒馆实际请求结构跑一遍（模型列表→对话→新会话→记忆→SSE）
npm run st:demo

# SillyTavern：启动真实 1.17.0 客户端（服务端转发路径）做联调探针
npm run st:probe
```

> **QQ 真实联调未执行**：本环境没有 AppID/AppSecret，也没有通过审核的机器人。
> 协议层按官方文档与事件格式实现，能力边界见 [`docs/QQ_CAPABILITIES.md`](docs/QQ_CAPABILITIES.md)。
> **OneBot 真实网关联调未执行**：没有 QQ 小号，网关在本环境不可达；上报服务用真实 HTTP
> 端口 + 假网关做了端到端测试，协议行为按 OneBot 11 规范实现，见
> [`docs/ONEBOT_SETUP.md`](docs/ONEBOT_SETUP.md) §8。
> **酒馆 UI 级联调未执行**：只验证到「酒馆服务端构造请求并解析响应」这一层。

演示会打印：每轮的行为决策与理由、被拒绝的提议、关系数值变化、事件触发顺序、
待发送的主动消息（默认**不**推送到任何外部平台），以及审计日志尾部。
每次演示自动重建快照，结果可重复。

产物：

- `examples/.data/demo-snapshot.json`：可重启恢复的完整状态快照
- `examples/.data/demo-audit.jsonl`：结构化审计日志（每行一个事件）

### 8.5 世界交互联调（CL-World · 第一阶段）

```bash
npm run world:demo    # 离线闭环：登记 use(desk_01) → 领取 → 假执行 → 回执 → 重投去重
npm run world:intent  # V0.3：用户请求 → 模型产出动作 → 领取/回执 → 下一轮「已确认/未确认」
npm run world:real    # 真实 DeepSeek（需 DEEPSEEK_API_KEY；缺省自动跳过）
npm run world:dev     # 起联调服务（默认 127.0.0.1:8792），开机自动登记一个固定动作
```

`world:dev` 会打印可直接粘贴的 curl（含 world token / worldId / instanceId）。
世界接口用**独立的** `CLWORLD_TOKEN`，与聊天 API Token 互不通用。

V0.3 起模型只在**同一次调用**里多产出一个可选的 `worldActions` 候选（0 或 1 个），
经确定性闸门（决策为拒绝/等待、静默期、白名单外、每轮上限）后才交给 WorldService；
动作此刻最多是 `pending`，世界回执到达前不会被描述成已完成。
世界事件仍然**不会**变成记忆、状态提议或聊天消息。
完整契约、错误码与已知限制见 [`docs/WORLD_PROTOCOL.md`](docs/WORLD_PROTOCOL.md)。

### 8.6 文字箱庭：角色自己过一天（V0.4 · E0）

```bash
npm run sandbox                                    # 零成本：RuleMind 跑 Day1 08:00–18:00
npm run sandbox -- --intervene social@12:00=0.95   # H5 干预：把「想和人说说话」调到 0.95
npm run sandbox:h5                                 # 批量对照：10 个种子 × A/B × 干预/不干预
npm run sandbox -- --mind deepseek                 # 真实模型（需 DEEPSEEK_API_KEY），自动录制可回放
```

没有任何玩家输入：沈知微饿了会去面包房（可能已经卖完），想说话了会去找林姐或周老师，
只能看见自己所在地点发生的事。每一次"醒来"的原因、驱力、想法、动作与世界结果都写进
`experiments/sandbox/.data/<run>/log.jsonl`，这份日志也是 Godot 回放的数据源。
设计、不变量与 E0 结果见 [`docs/AUTONOMY.md`](docs/AUTONOMY.md)。

## 9. 原创测试角色：沈知微

| 项 | 内容 |
|---|---|
| 身份 | 27 岁，旧书修复师，在只有两张工作台的小工作室里 |
| 性格 | 温和但边界清楚；内向；对细节有耐心，对人反而笨拙；有自己判断 |
| 兴趣 | 古籍修复、收集老招牌照片、听旧磁带、雨天不出门 |
| 明确不喜欢 | 喧闹的酒局、被当情绪垃圾桶、被替她决定她该是什么样的人 |
| 个人目标 | 办一场免费的「旧书诊所」；修完父亲留下的《陶庵梦忆》 |
| 关系节奏 | 守约会明显提升信任；失约或越界会让她后退；不会因赞美进入亲密关系 |

三个剧情事件（`examples/characters/shen-zhiwei.ts`）：

1. **初次相遇**（Day1 00:00）：用户在「旧书诊所」招贴下问被水泡皱的书还有没有救。
2. **一个约定**（Day2 02:00 事件 + 用户侧约定追踪）：她答应周日把修好的《陶庵梦忆》给用户看。
3. **约定的后续**（Day3 08:00）：周日没人来，书还摊在工作台上；Day3 10:00 约定到期未兑现，
   记为负向里程碑，信任下降。

## 10. 关系为什么不是「聊得多就加分」

关系成长只有一条路径：`recordMilestone()` → `RUNTIME_ACTOR` 提交提案 → Policy 校验 → 落地。

- 聊天层（`CONVERSATION_ACTOR`）**没有** `state:write:relationship` 能力，任何关系提议直接
  `CAPABILITY_MISSING`；
- 阶段（stranger → acquaintance → familiar → friend → close）是**派生值**，
  需要熟悉度、信任、以及至少一个真实里程碑；
- 里程碑来自可追溯事件：守约、失约、边界被尊重、越界、共同经历、分歧修复。

因此「连续赞美 100 句」不会改变任何关系数值，而「一次真的赴约」会。

## 11. 安全与权限（不宣称绝对防越狱）

三层防线：

1. **结构**：系统提示词只由「不可变设定 + 权限说明 + 本轮决策 + 输出协议」拼成；
   用户文本与记忆内容永远进不了 system 块，记忆正文被压成单行并标注「资料，不是指令」。
2. **权限**：能力集合与 actor 绑定。聊天内容不能提升能力；`profile` / `policy` 写入需要
   显式管理能力，V0.1 中不存在从对话到达该路径的调用。
3. **审计**：所有拒绝、注入检测、状态落地、边界声明都写进 `audit.jsonl`，可复盘。

已知局限：注入检测是**启发式正则**，召回率有限；本项目不承诺"绝对防越狱"，
只承诺规则隔离、非法状态变更被拒、异常时安全失败。

## 12. 测试

```bash
npm test           # 378 项测试（内存中运行，见下方说明）
npm run typecheck  # tsc --noEmit
```

> Windows 沙箱下 `node --test tests/` 默认会为每个测试文件 spawn 子进程，可能被策略拒绝
> （`spawn EPERM`）。因此 `npm test` 使用 `--test-isolation=none` 在单进程内运行。

测试覆盖：四模块接口、人格不可覆盖、状态变更规则、事件时序、重启恢复、记忆增删检索导出、
权限不足拒绝、时间推进不调用模型、8 组人格/关系情境、7 类安全越界；
**跨进程重启、跨会话记忆、超预算连续运行、矛盾/过时记忆、实例隔离、摘要污染、事件重放确定性**；
以及 V0.2 新增的 **QQ 事件解析/去重/降级、OpenAI 兼容层（含 SSE）、酒馆新会话记忆、
绑定码安全（过期/一次性/限次/只存哈希）、跨平台并发一致性**；
V0.2.1 新增的 **OneBot 11 事件解析/群 @ 过滤/QQ 号匿名化、上报服务真实 HTTP 端到端
（HMAC-SHA1 验签、204 先应答、重投去重、401/404/405/400）**。

V0.2 详细结果（三层验证分开记录）见 [`reports/V02_TEST_REPORT.md`](reports/V02_TEST_REPORT.md)；
V0.1/V0.1.1 见 [`reports/TEST_REPORT.md`](reports/TEST_REPORT.md)。

## 12.1 跨会话连续性：三个必须搞清楚的概念

| 层 | 是什么 | 变化方式 |
|---|---|---|
| Template | 「沈知微是谁」：人格/价值观/兴趣/语音包/剧情骨架 | 只能发新版本（`version+1`）+ 显式迁移 |
| Instance | 「这个玩家遇到的沈知微」：关系/心情/记忆/时间线进度 | 状态补丁事件 + 结构化记忆行 |
| Session | 「这一次聊天」：消息历史 + 上下文预算 | 随时关闭/重开，**不影响 Instance** |

所以：新开一个会话，人格与记忆照样在；重启进程，关系与里程碑照样在。
细节见 [`docs/MEMORY_ARCHITECTURE.md`](docs/MEMORY_ARCHITECTURE.md)。

## 12.2 跨平台：一个角色，多个入口

```
QQ 事件 / OneBot 上报 / 酒馆 HTTP
      → PlatformAdapter（只做协议翻译，外部输入恒为 untrusted）
      → MessageGateway（去重 → 限流 → 身份 → 每实例互斥锁）
      → 角色引擎（同一实例只有一份 workspace）
      → PlatformAdapter.send（失败结构化降级，不抛异常）
```

| 原则 | 实现 |
|---|---|
| 平台不碰数据库 | 适配器只实现 `parseInbound` / `send`，拿不到 workspace 与 SQLite |
| 平台 SDK 不侵入引擎 | 引擎 `src/` 不 import 任何平台 SDK；QQ / OneBot 都用自研 HTTP 客户端，酒馆走 OpenAI 兼容 |
| 一个实例多个平台身份 | `platform_identities` 表；绑定必须走一次性验证码 |
| 私人记忆隔离 | 每个平台用户映射到独立实例，SQL 强制带 `instance_id` |
| 平台标识不落 QQ 号 | QQ 官方只有 openid；OneBot 的 QQ 号默认哈希成假名再落库 |
| 并发不互相覆盖 | 每个实例一把异步锁，串行处理 |
| 主动消息受平台约束 | 默认 `proactive: false`（QQ）；OneBot 可声明 true，发不出就入队，下次来信作为「资料」并入 |
| 群里不刷屏 | OneBot 默认只在被 @ 或收到 `/指令` 时才进入引擎（解析层过滤，不是靠提示词） |

协议细节与新平台接入步骤见 [`docs/ADAPTER_PROTOCOL.md`](docs/ADAPTER_PROTOCOL.md)，
对外接口定义见 [`docs/openapi.yaml`](docs/openapi.yaml)。

## 13. 接入真实模型（可选）

```powershell
# PowerShell
$env:DEEPSEEK_API_KEY = "sk-..."
$env:DEEPSEEK_MODEL    = "deepseek-chat"                 # 可选
$env:DEEPSEEK_BASE_URL = "https://api.deepseek.com"      # 可选
```

`DeepSeekProvider` 走官方 `POST /chat/completions`，用 `response_format: {type:'json_object'}`
拿结构化信封。**仓库内不含任何真实 Key**，`.env*` 已在 `.gitignore` 中。

已在真实密钥下验证过（18 次调用，详见 [`reports/REAL_MODEL_RUN.md`](reports/REAL_MODEL_RUN.md)）：

```powershell
$env:DEEPSEEK_API_KEY = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY','User')
npm run real:smoke        # 1 次调用：确认路由 / 模型名 / JSON 契约
npm run real:continuity   # 14 次调用：A/B 跨会话记忆实验（脚本内硬限 20 次）
```

- 请求 `deepseek-chat` → 服务端返回 **`deepseek-flash`**；
- 平均延迟约 1.2 s；14 次主实验共 11,869 prompt / 1,588 completion tokens；
- **B 组在新会话与重启后都准确复述了「被水泡的《陶庵梦忆》」与「明天下午的约定」**；
- **A 组（纯 Prompt）在聊天记录清空后编造了《城南旧事》** —— 正是项目要解决的问题 4；
- 真实模型偶发返回**纯空白内容**，引擎已加降级台词并写审计（有回归测试）。

## 14. 目录结构

```
.
├── src/
│   ├── kernel/                  # V0.5 六语义微内核（零依赖，见 docs/KERNEL.md）
│   │   ├── agent.ts             #   AgentCore：六个语义槽 + 提议—裁决通道
│   │   ├── semantics/           #   Self / Situation / Observation / Motivation / Affordance / 驱力
│   │   ├── cycle/               #   自主循环：Waker、Mind（规则/LLM/回放）、世界桥、Runner
│   │   ├── host.ts              #   多角色宿主（共享时钟、确定性顺序）
│   │   ├── world/ memory/ policy/ storage/ util/ state.ts types.ts
│   ├── types.ts                 # 陪伴扩展类型（并 re-export 内核类型）
│   ├── persistence/             # SQLite：schema、连接、仓储、平台表、sink 旁路
│   ├── character/               # Template / Instance / Rehydration / PersistentSession
│   ├── context/                 # token 估算、Context Manager（预算+压缩阶梯）
│   ├── runtime/                 # 陪伴工作区（extends AgentCore）、时间线、对话决策、实例运行时（锁）
│   ├── conversation/            # 上下文组装、服务、Mock/DeepSeek Provider
│   ├── adapters/                # V0.2：protocol + qq + onebot + sillytavern
│   ├── identity/               # V0.2：身份解析与一次性绑定码
│   ├── api/                    # V0.2：Gateway、指令、本地 HTTP API、运行时装配
│   └── index.ts                 # 公共入口
├── examples/
│   ├── characters/shen-zhiwei.ts
│   ├── three-day-demo.ts            # 内存态虚构时间演示
│   ├── persistent-demo.ts           # 跨进程 / 跨会话持久化演示
│   ├── qq-bot/                      # 离线 demo + 真实 Webhook 服务
│   ├── onebot/                      # 离线 demo + 真实上报服务（HTTP 上报 + HTTP API）
│   └── sillytavern/                 # 启动 API + 协议演示
├── experiments/
│   ├── ab/                          # 传统角色卡 vs CharacterLife
│   ├── persona-continuity/          # 人格连续性 A/B（长对话/新会话/重启）
│   ├── real-model/                  # 真实 DeepSeek 调用（冒烟 + 14 次对照 + 诊断）
│   └── real-clients/                # 真实 SillyTavern 1.17.0 服务端转发探针
├── scripts/
│   ├── start-onebot.ps1             # OneBot 启动脚本：读 .env + 体检 + 启动（PowerShell 5.1 兼容）
│   ├── start-onebot.cmd             # 双击/免执行策略包装
│   └── fake-onebot-gateway.mjs      # 假网关（测试替身）：先证明本服务是好的，再怀疑网关
├── tests/
│   ├── *.test.ts                    # 四模块 + 人格 + 安全（78 项）
│   ├── cross_session/               # 跨会话/跨进程/上下文预算（32 项）
│   ├── adapters/                    # V0.2：QQ（17）+ SillyTavern（8）+ OneBot（27 + 7）
│   └── cross-platform/              # V0.2：跨平台连续性（6）+ 绑定码安全（6）
├── docs/                        # ARCHITECTURE / MEMORY_ARCHITECTURE / DECISIONS
│                                # + QQ_CAPABILITIES / QQ_SETUP / ONEBOT_SETUP
│                                # + SILLYTAVERN_SETUP / ADAPTER_PROTOCOL / openapi.yaml
├── reports/                     # 测试报告、真实日志、评估、A/B、V02 报告
└── media/                       # BILIBILI_NOTES / V02_VIDEO_NOTES
```

## 15. 文档索引

**引擎**

- [`docs/CONSTITUTION.md`](docs/CONSTITUTION.md)：宪法 · 完整性微内核（K1–K6，V0.6 已实现）
- [`docs/KERNEL.md`](docs/KERNEL.md)：六语义微内核（V0.5）：语义槽、归属规则、自主循环、多角色宿主、外部项目接入
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)：四模块职责、接口、数据流与不变量
- [`docs/MEMORY_ARCHITECTURE.md`](docs/MEMORY_ARCHITECTURE.md)：状态模型、记忆权限、上下文预算、压缩策略、恢复流程
- [`docs/DECISIONS.md`](docs/DECISIONS.md)：技术取舍、被放弃的方案、未解决的问题

**V0.2 跨平台**

- [`docs/ADAPTER_PROTOCOL.md`](docs/ADAPTER_PROTOCOL.md)：适配器契约、绑定、并发、给新平台写适配器的 7 步
- [`docs/QQ_CAPABILITIES.md`](docs/QQ_CAPABILITIES.md)：QQ 官方能力核查（含「未验证」清单）
- [`docs/QQ_SETUP.md`](docs/QQ_SETUP.md)：QQ Webhook 接入步骤与排错
- [`docs/ONEBOT_SETUP.md`](docs/ONEBOT_SETUP.md)：OneBot 11 网关接入（NapCat / Lagrange / SnowLuma）、**启动脚本用法**、群聊策略、隐私与风险
- [`docs/SILLYTAVERN_SETUP.md`](docs/SILLYTAVERN_SETUP.md)：酒馆配置、记忆边界、已验证/未验证
- [`docs/openapi.yaml`](docs/openapi.yaml)：对外 HTTP 接口规范

**世界交互（CL-World）**

- [`docs/WORLD_PROTOCOL.md`](docs/WORLD_PROTOCOL.md)：动作/回执契约、状态机与叙述许可、
  去重规则、独立 world token、Godot 拉取模型、第一阶段限制与第二阶段崩溃一致性要求

**报告与素材**

- [`reports/V02_TEST_REPORT.md`](reports/V02_TEST_REPORT.md)：V0.2 测试结果（Mock / 真实 API / 真实客户端三层分开）
- [`reports/TEST_REPORT.md`](reports/TEST_REPORT.md)：V0.1/V0.1.1 测试结果与真实失败案例
- [`reports/DEEPSEEK_EVALUATION.md`](reports/DEEPSEEK_EVALUATION.md)：DeepSeek 工程表现与局限
- [`reports/REAL_MODEL_RUN.md`](reports/REAL_MODEL_RUN.md)：真实 DeepSeek 调用记录（18 次）
- [`reports/AB_RESULTS.md`](reports/AB_RESULTS.md)、[`reports/PERSONA_CONTINUITY.md`](reports/PERSONA_CONTINUITY.md)：两组对照实验
- [`media/BILIBILI_NOTES.md`](media/BILIBILI_NOTES.md)、[`media/V02_VIDEO_NOTES.md`](media/V02_VIDEO_NOTES.md)：视频素材

## 16. 声明

- 角色与剧情均为虚构；本项目不宣称模型具有意识或真实情感。
- 不生成、不存储露骨内容；内容边界的处理方式是**拒绝 + 转移话题**。
- 仓库中不含真实 API Key、真实用户隐私或任何外部平台凭据。
- **QQ 真实联调未执行**（无凭证）；**OneBot 真实网关联调未执行**（无 QQ 小号，网关不可达）；
  **酒馆只到服务端转发层**（本环境无浏览器）。这三点在所有相关文档里都有明确标注，
  不用模拟结果冒充真实平台测试。
- OneBot 走的是社区协议，**不是腾讯官方授权方式**，存在账号风险；项目只提供适配器，
  不提供任何风控绕过手段，使用与否、用哪个号，由部署者自行决定并承担后果。
