# CL 后台（Owner Console）

可视化每个实例的六语义，审批模型提出的记忆和关键世界事件的效果，并以插件形式接入引擎层（游戏适配层）的后台。

代码：`src/console/`（服务、插件契约、静态页面），`src/runtime/memory-review.ts`（记忆待审队列）。内核 `src/kernel/**` 未改动。

## 运行

后台在 CL 进程内运行，与聊天 API 共用同一份内存状态，不会出现第二个写入方。

- 鲸鲸视频实例（扩展仓库 `CharacterLife-VideoCohost`）：其启动入口会一并开启后台，地址 `http://127.0.0.1:8788/`（`CHARACTERLIFE_CONSOLE_PORT` 可改）。
- 令牌：首次启动生成到扩展的本地数据目录（默认 `jingjing-overlay/data/console-token.txt`），也可用 `CHARACTERLIFE_CONSOLE_TOKEN` 指定。它与聊天令牌、世界令牌分开；启动日志只打印文件位置，不打印令牌。
- 离线演示（内存数据库、脚本模型、模拟事件，不读写真实数据）：扩展仓库中的 `console-demo.ts`，打开 `http://127.0.0.1:8798/`，演示令牌会打印在终端。

## 安全边界

- 只能监听回环地址；`Host` 头不是 localhost / 127.0.0.1 / ::1 的请求一律拒绝，用来防止 DNS 重绑定。
- 所有 `/api` 请求都要 Bearer 令牌，不使用 Cookie。页面只把令牌存在当前标签页的 sessionStorage。
- 页面通过 CSP 只加载自身脚本；所有数据都用 `textContent` 渲染，记忆或插件文本不会被当成 HTML。
- 写操作在实例锁内执行，执行完保存快照。删除记忆是软删除，使用 `OWNER_ACTOR`，有审计记录。

## 页面

| 页 | 内容 |
|---|---|
| 六语义 | Self（只读人格、身心状况）、Situation（事实、库存）、Observation（最近感知，含事件与出处）、Memory（计数、关系认识）、Motivation（目标、驱力、承诺）、Affordance（各渠道动作；鲸鲸的 world 渠道为空） |
| 记忆 | 按关键词、标签筛选，可包含已删除记忆；可软删除 |
| 待审记忆 | 模型提出的记忆，逐条批准或拒绝 |
| 审计 | 本进程内的审计事件，重启后清空；持久记录见账本与事件日志 |
| 插件 | 实例扩展提供的面板 |

## 审批语义

**记忆**（`memoryReview: 'model'`）：聊天模型每轮提出的 `memoryWrites` 不直接写入，而是进入 `extensions['cl.memoryReview']`，随实例快照持久化，重启后保留。批准时用原来的 `CONVERSATION_ACTOR` 和原对话轮次 `sourceRef` 写入，同样经过 Policy；被 Policy 拒绝的会标为 rejected 并附原因。运行时依据世界证据写入的记忆（记仇本、节拍、flag 结算）不进这个队列，有问题可以在后台软删除。未开启时行为和以前一致。

**世界事件**（游戏适配层 `worldReview: 'review'`）：事件本身仍会实时进入 Observation / Situation，鲸鲸能立刻接话。等待批准的是事件的**效果**，也就是推进剧本节拍、写入剧情记忆。日常事件直接生效，不进队列：`day_start:*`、`rent_paid`、`item_bought:*`、`npc_left:*`、`npc_arrived:*`，但 `npc_arrived:security_officer` 例外，仍然要审批。被拒绝的效果会记为已处理，重放时不会再次入队。插件里可以切换成自动模式。

注意：批准时按**当前**剧本状态执行。如果先批准后到的事件，前置节拍可能还没进入，这个事件就不会推进剧本。所以“按顺序批准全部”会按到达顺序处理。

## 插件契约（`src/console/plugin.ts`）

实例扩展（`InstanceExtension`）可以实现 `consolePlugin(): ConsolePlugin`：

- `panels()` 返回结构化面板，区块类型有 `fields`、`table`（行可带操作）、`text`、`actions`；
- `act(actionId, params, actorId)` 在服务端执行操作，抛出的错误会以 409 返回给页面；
- 插件不能提供脚本或 HTML。操作参数只能是标量，需要填写的内容由 `fields` 声明，页面弹窗收集。

鲸鲸的 Probably Stolen 插件（位于扩展仓库 `CharacterLife-VideoCohost`）有四个面板：世界事件审批（逐条或按顺序批准、切换模式）、剧本（节拍表、推进记录）、每期与 Flag（收尾本期、逐条审核候选记忆、收为承诺时填写截止天数、承诺账本）、事件覆盖（能产生和缺失的事件）。逐条审核全部决定后，审核自动完成；“完成审核”会丢弃未决定的候选记忆，未决定的 flag 留到下一次审核。文件和命令行审核仍然可用。

## 已知限制

- 陪伴层的约定识别（`promiseText`）不经过审批，仍会写入一条“约定”记忆和普通承诺。
- 审计页只显示本进程的内存审计。
- 页面没有做多人并发编辑保护；同一实例的写操作由实例锁串行化。
- 只在离线演示和自动化测试中验证过，没有在真实直播中使用过。
