# AGENTS.md · 给 AI 协作者的入口

适用于 Claude Code、Codex、GPT 以及任何读取本仓库的 agent。这里只写**去哪读、按什么规矩做**；
项目状态、设计和决策都在下面链接的文件里，不在本文件重复。

## 开工顺序

1. **[`TodoList.md`](TodoList.md)**：任务状态与交接的单一入口。先看「当前焦点」、§1 任务表和 §4 最近的交接记录。
2. TodoList §0 列出的事实基线文档，只读与本次任务相关的部分。
3. 核对 `main` 最新代码。**不要凭旧会话、旧 README 或聊天记录假定状态**；文档与代码冲突时以代码和测试为准，并在交接里指出。

## 三类文件，各管一件事

| 文件 | 管什么 | 怎么改 |
|---|---|---|
| `TodoList.md` | 现在在做什么、谁在做、卡在哪、下一步 | 认领、更新状态、追加交接记录（规则见 TodoList §3） |
| `docs/DECISIONS.md` | 为什么这样做、放弃了什么、还差什么 | **只追加新节**，不改旧节编号；代码注释和其他文档按 `§N` 引用它 |
| `docs/*.md` 其余文件 | 设计与协议（KERNEL、CONSTITUTION、WORLD_PROTOCOL 等） | 随实现同步修改 |

## 硬约束

- **运行时依赖为 0。** 新增运行时依赖须先在 DECISIONS 里写明理由并经主导者同意。
- Node ≥ 22.6，直接运行 `.ts`（类型擦除）。不要使用 enum、namespace、参数属性等不可擦除语法（`erasableSyntaxOnly` 会拦截）。
- 验证：`npm test`（`--test-isolation=none` 是为了绕开 Windows 沙箱下的 `spawn EPERM`，不要去掉）和 `npm run typecheck`。交接时写明实际跑出的数字。
- 不向仓库写入 API Key、真实聊天原文、群友身份或未授权素材（`.gitignore` 已覆盖常见产物）。

## 仓库边界

- CL 只放通用内核、runtime 和通用示例。以下内容在各自仓库，进度不能从 CL 文档推断：
  - 2.5D 观察箱庭：[CharacterLife-World](https://github.com/AprilB3V/CharacterLife-World)
  - 《罐中斗》游戏与规则：[Free-Roam](https://github.com/AprilB3V/Free-Roam)
  - 鲸鲸视频搭档、角色模板与剧本：CharacterLife-VideoCohost
- 扩展只通过 `package.json` `exports` 的公开入口（`.`、`/kernel`、`/runtime`、`/api`、`/console`）依赖 CL。不要在外部项目引用 `src/**` 的内部路径。
- 外部世界规则、胜负和表现层不得反向写进内核。

## 收尾（每次会话结束前）

1. 更新 `TodoList.md`：任务状态，以及一条交接记录（日期 · 任务 ID / 执行者、做了什么、测试命令与结果、未验证的部分）。
2. 本次做了取舍，就在 `docs/DECISIONS.md` 末尾追加一节（标题带版本或日期）。
3. 在网页对话（Claude Web、ChatGPT）里讨论出的决定同样要写回这两个文件。没写回仓库的决定，下一个会话看不到。
