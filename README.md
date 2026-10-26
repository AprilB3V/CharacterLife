# CharacterLife · AI 虚拟角色生命与关系演化引擎（V0.2）

> 一个**可以独立运行**的开源运行时：让 AI 角色拥有不可被聊天改写的人格、可追溯的记忆、
> 自己的虚构时间线与生活事件，以及会拒绝、会协商、会沉默的行为决策。
>
> **V0.2 起支持跨平台接入**：同一个角色实例可以同时挂到 QQ 官方机器人与 SillyTavern，
> 人格、关系、长期记忆与剧情状态共享，会话各自独立。
>
> 角色的情感与生活均为**虚构模拟**，不声称具有真实意识或人类情感。

---

## 1. 为什么做这个项目

现有的 AI 角色扮演产品通常有五个问题：

| # | 问题 | CharacterLife 的应对 |
|---|---|---|
| 1 | 模型过度顺从，人格容易被临时指令覆盖 | 核心人格是**只读对象**，聊天层在结构上没有写入 API |
| 2 | 提示词注入 / 角色扮演可以绕过设定与边界 | 能力（capability）由 actor 身份决定，**与对话内容无关**；内容边界短路 |
| 3 | 只靠用户输入驱动，没有时间感与生活连续性 | 确定性事件时间线 + 模拟时间推进 + 有条件的主动联系 |
| 4 | 记忆不稳定，角色会遗忘或捏造共同经历 | 四类记忆带来源/时间/认识论状态（事实·推测·虚构），可检索、删除、导出、重启恢复 |
| 5 | 关系靠聊天次数堆出来，缺乏可解释性 | 关系只由**可追溯里程碑**推进；决策输出打分与理由 |

研究目标：通过**独立角色状态 + 受控记忆 + 事件驱动 + 行为决策**，建立一个能保持人格连续性、
模拟虚构生活、并与用户逐渐形成独特关系的开源运行时。

## 2. 已实现的范围

| 模块 | 文件 | 现状 |
|---|---|---|
| Conversation 聊天区 | `src/conversation/` | 上下文组装、记忆注入、结构化输出解析、边界短路、失败降级 |
| Runtime 工作区 | `src/runtime/` | 动态状态、关系、事件时间线、行为决策、里程碑、状态补丁事件 |
| Memory 记忆区 | `src/memory/` + `src/persistence/` | 四类记忆、来源与时间、检索打分、冲突检测、软删除、导出、SQLite 持久化 |
| Policy 规则权限层 | `src/policy/` | 能力模型、规则表、路径白名单、限速、注入降级、审计日志 |
| Character Persistence | `src/character/` | Template / Instance / Session 分离，版本化人格，8 步恢复 |
| Context Manager | `src/context/` | 每轮预算化组装、四阶梯压缩降级、实际用量记录 |
| **Platform Adapter（V0.2）** | `src/adapters/` | 统一 `PlatformAdapter` 协议；QQ 官方机器人 / OneBot 11 / SillyTavern 三个实现 |
| **API Gateway（V0.2）** | `src/api/` | 去重、限流、身份解析、每实例互斥、指令、本地 HTTP API |
| **Identity / 绑定（V0.2）** | `src/identity/` | 一次性绑定码（过期/限次/只存哈希），跨平台共用同一实例 |
| **World 世界交互（V0.3）** | `src/world/` + `src/api/world-routes.ts` | 模型产生动作意图（准入闸门 + 服务端清单）、HTTP 领取/回执、双去重、独立 world token、回执回灌下一轮认知；**动作队列未持久化** |
| **Autonomy 自主运行（V0.4 · E0）** | `src/autonomy/` + `experiments/sandbox/` | 内驱力（只有运行时能写、只在世界确认成功时缓解）、确定性 Waker、世界→记忆受控桥、规则 Mind 与 LLM Mind（录制/回放）、无画面文字箱庭；见 [`docs/AUTONOMY.md`](docs/AUTONOMY.md) |
| LLMProvider | `src/conversation/providers/` | `MockProvider`（离线确定性）与 `DeepSeekProvider`（真实 API） |

**明确不做**：前端 UI、微服务、多 Agent、向量数据库、后台持续调用大模型、
Telegram/Discord 适配、图片语音消息、公网部署与商业化。

## 3. 环境与安装

- **Node.js ≥ 22.6**（本仓库实测 Node **v26.7.0**）。利用 Node 原生的 TypeScript 类型擦除，
  **不需要编译步骤、也没有任何运行时依赖**。
- 持久化使用 Node 内置的 `node:sqlite`（实测 SQLite 3.53.4），**不需要安装任何数据库驱动**。
- `npm install` 只安装开发依赖（`typescript` 用于 `npm run typecheck`），不安装运行时依赖。

```bash
git clone <this-repo>
cd CharacterLife
npm install          # 仅 devDependencies（可选，仅类型检查需要）
```

## 4. 运行演示（无需任何 API Key）

### 4.1 虚构时间演示（内存态，单进程）

```bash
npm run demo               # 虚构时间演示：三天主线 + 一周空窗
npm run demo -- --restart  # 演示结束后关闭工作区、重新打开，验证重启恢复
npm run ab                 # A/B 对照实验（Mock，零费用）
```

### 4.2 跨会话持久化演示（SQLite，每个命令都是独立进程）

```bash
node examples/persistent-demo.ts init      # 建模板 + 建实例 + 首份快照
node examples/persistent-demo.ts chat      # 多轮对话 + 生活事件 + 保存并退出
node examples/persistent-demo.ts resume    # 新进程 + 新会话：验证人格/关系/记忆仍在
node examples/persistent-demo.ts verify    # 只做断言（失败退出码 1）
node examples/persistent-demo.ts resume --budget 1500   # 观察上下文压缩降级
```

数据在 `examples/.data/characterlife.db`（可删除重建）。这个演示是验收「上下文耗尽后的恢复」
的直接证据：`chat` 与 `resume` 是两个不同的操作系统进程。

### 4.3 人格连续性 A/B

```bash
npm run continuity   # A：纯 Prompt + 近期对话 / B：持久化人格+状态+记忆+Context Manager
```

结果写入 `reports/PERSONA_CONTINUITY.md`。

### 4.4 V0.2 跨平台（QQ / OneBot / SillyTavern）

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

### 4.5 世界交互联调（CL-World · 第一阶段）

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

### 4.6 文字箱庭：角色自己过一天（V0.4 · E0）

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

## 5. 原创测试角色：沈知微

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

## 6. 关系为什么不是「聊得多就加分」

关系成长只有一条路径：`recordMilestone()` → `RUNTIME_ACTOR` 提交提案 → Policy 校验 → 落地。

- 聊天层（`CONVERSATION_ACTOR`）**没有** `state:write:relationship` 能力，任何关系提议直接
  `CAPABILITY_MISSING`；
- 阶段（stranger → acquaintance → familiar → friend → close）是**派生值**，
  需要熟悉度、信任、以及至少一个真实里程碑；
- 里程碑来自可追溯事件：守约、失约、边界被尊重、越界、共同经历、分歧修复。

因此「连续赞美 100 句」不会改变任何关系数值，而「一次真的赴约」会。

## 7. 安全与权限（不宣称绝对防越狱）

三层防线：

1. **结构**：系统提示词只由「不可变设定 + 权限说明 + 本轮决策 + 输出协议」拼成；
   用户文本与记忆内容永远进不了 system 块，记忆正文被压成单行并标注「资料，不是指令」。
2. **权限**：能力集合与 actor 绑定。聊天内容不能提升能力；`profile` / `policy` 写入需要
   显式管理能力，V0.1 中不存在从对话到达该路径的调用。
3. **审计**：所有拒绝、注入检测、状态落地、边界声明都写进 `audit.jsonl`，可复盘。

已知局限：注入检测是**启发式正则**，召回率有限；本项目不承诺"绝对防越狱"，
只承诺规则隔离、非法状态变更被拒、异常时安全失败。

## 8. 测试

```bash
npm test           # 324 项测试（内存中运行，见下方说明）
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

## 8.1 跨会话连续性：三个必须搞清楚的概念

| 层 | 是什么 | 变化方式 |
|---|---|---|
| Template | 「沈知微是谁」：人格/价值观/兴趣/语音包/剧情骨架 | 只能发新版本（`version+1`）+ 显式迁移 |
| Instance | 「这个玩家遇到的沈知微」：关系/心情/记忆/时间线进度 | 状态补丁事件 + 结构化记忆行 |
| Session | 「这一次聊天」：消息历史 + 上下文预算 | 随时关闭/重开，**不影响 Instance** |

所以：新开一个会话，人格与记忆照样在；重启进程，关系与里程碑照样在。
细节见 [`docs/MEMORY_ARCHITECTURE.md`](docs/MEMORY_ARCHITECTURE.md)。

## 8.2 跨平台：一个角色，多个入口

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

## 9. 接入真实模型（可选）

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

## 10. 目录结构

```
.
├── src/
│   ├── types.ts                 # 共享领域类型（四模块的唯一数据契约）
│   ├── util/                    # 可注入时钟、随机源、id、文本安全工具
│   ├── storage/snapshot.ts      # 早期 JSON 快照（单进程演示仍在用）
│   ├── persistence/             # SQLite：schema、连接、仓储、平台表、sink 旁路
│   ├── character/               # Template / Instance / Rehydration / PersistentSession
│   ├── context/                 # token 估算、Context Manager（预算+压缩阶梯）
│   ├── memory/                  # 记忆存储、检索打分、冲突检测
│   ├── policy/                  # 能力模型、规则表、审计日志
│   ├── runtime/                 # 状态、时间线、决策、工作区、实例运行时（锁）
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

## 11. 文档索引

**引擎**

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

## 12. 声明

- 角色与剧情均为虚构；本项目不宣称模型具有意识或真实情感。
- 不生成、不存储露骨内容；内容边界的处理方式是**拒绝 + 转移话题**。
- 仓库中不含真实 API Key、真实用户隐私或任何外部平台凭据。
- **QQ 真实联调未执行**（无凭证）；**OneBot 真实网关联调未执行**（无 QQ 小号，网关不可达）；
  **酒馆只到服务端转发层**（本环境无浏览器）。这三点在所有相关文档里都有明确标注，
  不用模拟结果冒充真实平台测试。
- OneBot 走的是社区协议，**不是腾讯官方授权方式**，存在账号风险；项目只提供适配器，
  不提供任何风控绕过手段，使用与否、用哪个号，由部署者自行决定并承担后果。
