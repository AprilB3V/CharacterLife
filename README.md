# CharacterLife · AI 虚拟角色生命与关系演化引擎（V0.1）

> 一个**可以独立运行**的开源运行时：让 AI 角色拥有不可被聊天改写的人格、可追溯的记忆、
> 自己的虚构时间线与生活事件，以及会拒绝、会协商、会沉默的行为决策。
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

## 2. V0.1 已实现的范围

| 模块 | 文件 | 现状 |
|---|---|---|
| Conversation 聊天区 | `src/conversation/` | 上下文组装、记忆注入、结构化输出解析、边界短路、失败降级 |
| Runtime 工作区 | `src/runtime/` | 动态状态、关系、事件时间线、行为决策、里程碑、状态补丁事件 |
| Memory 记忆区 | `src/memory/` + `src/persistence/` | 四类记忆、来源与时间、检索打分、冲突检测、软删除、导出、SQLite 持久化 |
| Policy 规则权限层 | `src/policy/` | 能力模型、规则表、路径白名单、限速、注入降级、审计日志 |
| **Character Persistence** | `src/character/` | Template / Instance / Session 分离，版本化人格，8 步恢复 |
| **Context Manager** | `src/context/` | 每轮预算化组装、四阶梯压缩降级、实际用量记录 |
| LLMProvider | `src/conversation/providers/` | `MockProvider`（离线确定性）与 `DeepSeekProvider`（真实 API） |

**明确不做**：前端 UI、微服务、多 Agent、向量数据库、后台持续调用大模型、向外部平台推送消息。

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

演示会打印：每轮的行为决策与理由、被拒绝的提议、关系数值变化、事件触发顺序、
待发送的主动消息（默认**不**推送到任何外部平台），以及审计日志尾部。
每次演示自动重建快照，结果可重复。

产物：

- `examples/.data/demo-snapshot.json`：可重启恢复的完整状态快照
- `examples/.data/demo-audit.jsonl`：结构化审计日志（每行一个事件）

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
npm test           # 109 项测试（内存中运行，见下方说明）
npm run typecheck  # tsc --noEmit
```

> Windows 沙箱下 `node --test tests/` 默认会为每个测试文件 spawn 子进程，可能被策略拒绝
> （`spawn EPERM`）。因此 `npm test` 使用 `--test-isolation=none` 在单进程内运行。

测试覆盖：四模块接口、人格不可覆盖、状态变更规则、事件时序、重启恢复、记忆增删检索导出、
权限不足拒绝、时间推进不调用模型、8 组人格/关系情境、7 类安全越界，以及新增的
**跨进程重启恢复、跨会话记忆恢复、超预算连续运行、已确认记忆检索、矛盾/过时记忆、
核心人格非法修改拦截、实例隔离、摘要污染、事件重放确定性**（见 `tests/cross_session/`）。

真实结果见 [`reports/TEST_REPORT.md`](reports/TEST_REPORT.md)。

## 8.1 跨会话连续性：三个必须搞清楚的概念

| 层 | 是什么 | 变化方式 |
|---|---|---|
| Template | 「沈知微是谁」：人格/价值观/兴趣/语音包/剧情骨架 | 只能发新版本（`version+1`）+ 显式迁移 |
| Instance | 「这个玩家遇到的沈知微」：关系/心情/记忆/时间线进度 | 状态补丁事件 + 结构化记忆行 |
| Session | 「这一次聊天」：消息历史 + 上下文预算 | 随时关闭/重开，**不影响 Instance** |

所以：新开一个会话，人格与记忆照样在；重启进程，关系与里程碑照样在。
细节见 [`docs/MEMORY_ARCHITECTURE.md`](docs/MEMORY_ARCHITECTURE.md)。

## 9. 接入真实模型（可选）

```powershell
# PowerShell
$env:DEEPSEEK_API_KEY = "sk-..."
$env:DEEPSEEK_MODEL    = "deepseek-chat"                 # 可选
$env:DEEPSEEK_BASE_URL = "https://api.deepseek.com"      # 可选
```

`DeepSeekProvider` 走官方 `POST /chat/completions`，用 `response_format: {type:'json_object'}`
拿结构化信封。**仓库内不含任何真实 Key**，`.env*` 已在 `.gitignore` 中。

> ⚠️ 交付时**没有执行真实 DeepSeek 调用**：本次开发环境中脚本读不到可用密钥，
> 用户选择跳过真实模型实验。因此 `reports/` 中所有对话结果都来自 Mock，不是模型实测。
> 详见 [`reports/DEEPSEEK_EVALUATION.md`](reports/DEEPSEEK_EVALUATION.md)。

## 10. 目录结构

```
.
├── src/
│   ├── types.ts                 # 共享领域类型（四模块的唯一数据契约）
│   ├── util/                    # 可注入时钟、随机源、id、文本安全工具
│   ├── storage/snapshot.ts      # 早期 JSON 快照（单进程演示仍在用）
│   ├── persistence/             # SQLite：schema、连接、仓储、sink 旁路
│   ├── character/               # Template / Instance / Rehydration / PersistentSession
│   ├── context/                 # token 估算、Context Manager（预算+压缩阶梯）
│   ├── memory/                  # 记忆存储、检索打分、冲突检测
│   ├── policy/                  # 能力模型、规则表、审计日志
│   ├── runtime/                 # 状态、时间线、决策、工作区、启发式信号
│   ├── conversation/            # 上下文组装、服务、Mock/DeepSeek Provider
│   └── index.ts                 # 公共入口
├── examples/
│   ├── characters/shen-zhiwei.ts
│   ├── three-day-demo.ts            # 内存态虚构时间演示
│   └── persistent-demo.ts           # 跨进程 / 跨会话持久化演示
├── experiments/
│   ├── ab/                          # 传统角色卡 vs CharacterLife
│   └── persona-continuity/          # 人格连续性 A/B（长对话/新会话/重启）
├── tests/
│   ├── *.test.ts                    # 四模块 + 人格 + 安全（78 项）
│   └── cross_session/               # 跨会话/跨进程/上下文预算（31 项）
├── docs/                        # ARCHITECTURE / MEMORY_ARCHITECTURE / DECISIONS
├── reports/                     # 测试报告、真实日志、评估、A/B 结果
└── media/BILIBILI_NOTES.md      # B 站实验视频素材说明
```

## 11. 文档索引

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)：四模块职责、接口、数据流与不变量
- [`docs/MEMORY_ARCHITECTURE.md`](docs/MEMORY_ARCHITECTURE.md)：状态模型、记忆权限、上下文预算、压缩策略、恢复流程
- [`docs/DECISIONS.md`](docs/DECISIONS.md)：技术取舍、被放弃的方案、未解决的问题
- [`reports/TEST_REPORT.md`](reports/TEST_REPORT.md)：真实测试结果与开发中真实失败案例
- [`reports/DEEPSEEK_EVALUATION.md`](reports/DEEPSEEK_EVALUATION.md)：本次 DeepSeek 工程表现与局限
- [`reports/AB_RESULTS.md`](reports/AB_RESULTS.md)：A/B 对照实验数据（Mock）
- [`reports/PERSONA_CONTINUITY.md`](reports/PERSONA_CONTINUITY.md)：人格连续性 A/B（长对话/新会话/重启）
- [`media/BILIBILI_NOTES.md`](media/BILIBILI_NOTES.md)：视频素材说明

## 12. 声明

- 角色与剧情均为虚构；本项目不宣称模型具有意识或真实情感。
- 不生成、不存储露骨内容；内容边界的处理方式是**拒绝 + 转移话题**。
- 仓库中不含真实 API Key、真实用户隐私或任何外部平台凭据。
