# 鲸鲸视频搭档 · 第一季剧本接入（CL-011，试验，未实测）

《绝命鲸师》第一季：游戏《Probably Stolen》实况，鲸鲸以文字回复。剧本不是台词稿，而是一组**只由游戏事件触发**的节拍；节拍只改变注入的立场提示、Memory 与承诺账本，具体台词由模型现场生成。

代码在 `examples/video-cohost/`（游戏适配层），本任务**未修改** `src/kernel/**`。

## 1. 现状（以代码为准）

| 环节 | 实际情况 |
|---|---|
| 浮窗中转 | 本机 `jingjing-overlay/relay.mjs:8790`（不在本仓库）调用 CL 原生 `/v1/messages`（流式），不是 `/v1/chat/completions`；后者保留兼容。 |
| CL 入口 | `examples/video-cohost/start-server.ts` → `assembleRuntime` → SillyTavern 适配器 → `MessageGateway` → `InstanceRuntimeManager`；身份 `jingjing-video`，世界 `world_jingjing_video`，实例 `inst_001`。 |
| 游戏读取器 | `C:/Git/Pro.S_Mods/JingjingWorldBridge`（游戏 IMod + Harmony，只读，不在 git）每 2 秒写 `state.json`；中转 `game-world.mjs` 分页后以 `kind: observation` 投递到 `/v1/world/events`。 |
| Percept | `JingjingGameAdapter.sync()` 把快照与事件写成 `source: 'world'` 的 Percept，并经 `applyPercept` 推出 Situation；用户语音为 `source: 'user'` 的 Percept。 |
| 世界上下文 | `renderWorldPromptSection(world, 'reference')` 把实例世界上下文放在**用户消息的数据区**，不进 system 块。剧本立场经此注入，不进 Situation。 |
| 模板 | `examples/characters/jingjing.ts` 已是 `jingjing@3`（CL-010 改名）；本机数据库仍是 `maibot@2`，下次启动时由 `migrate-template.ts` 先备份再迁移。v3 尚未写入任何数据库，本次在 v3 内修改措辞，未改 v2。 |
| 内核改动 | CL-010（Codex，未提交）已改动 `src/kernel/types.ts`、`semantics/motivation.ts`、`semantics/situation.ts`。CL-011 没有新增内核改动；flag 截止天数保存在适配层扩展状态，因为内核的 `criterion` 没有天数字段。 |

## 2. 六语义归属

| 内容 | 落点 |
|---|---|
| 鲸鲸通用性格 | Self.persona（`jingjing.ts`，只读） |
| 世界观、本季设定、当前节拍立场、开场账本 | 世界上下文（`adapter.worldContext()` → reference 平面） |
| 资金、库存、调查进度、犯罪值、声望、天数、当前来客 | Situation（Percept → `applyPercept`） |
| 游戏状态变化、主播语音 | Observation（`world` / `user`） |
| 记仇本、共犯账、已见剧情（按局）、节拍推进、每期摘要 | Memory，`origin: runtime_event`，`sourceRef` 指向世界事件 |
| 主播 flag | 审核通过后才进 Motivation.commitments；由运行时按 Situation 结算 |
| 能力 | Affordance：只有 conversation；world 为空（测试断言） |

## 3. 事件清单

阈值与转变由适配层比较数值产生（`season/events.ts`，阈值在 `season/config.ts`），模型不比较数字。

| 事件 | 当前能否产生 | 来源 |
|---|---|---|
| `day_start:<n>` | 能 | 适配层：快照天数增加（本局首个快照也产生） |
| `deficit` / `deficit_cleared` | 能 | 适配层：资金跨过 0 |
| `deficit_persisted` | 能 | 适配层：新的一天资金仍为负（B1 用，表示赤字持续） |
| `rent_paid` | 能 | 读取器：`RunStats.OnRentPaid` |
| `item_bought:<item>` | 能 | 读取器：`RunStats.OnItemBought` |
| `investigation_near_threshold`（≥75）/ `investigation_over_threshold`（≥80） | 能 | 适配层；中转也会发 75 线事件，重复无副作用 |
| `npc_arrived:security_officer` | 能 | 中转：当前来客变化，`isSecurity` 映射为 `security_officer` |
| `kill:ai_controlled` | 能 | 读取器：`RunStats.OnAugShot` |
| `story:{cartel,revolution,church}.first_visit` | 能 | 中转：在场来客属于该派系 |
| `first_chem_sale` / `profit_margin_high` | 适配层已实现，**缺上游** | 需要读取器发出带 `price`、`profit` 的 `sale:<item>` |

**缺失事件**（读取器与中转目前都不产生；适配层能接收，剧本相应节拍在实机中不会触发）：

| 事件 | 影响节拍 | 静态分析候选（未实测，参数含义未验证） |
|---|---|---|
| `sale:<item>`（含售价、利润） | B3 | `RunStats.OnItemSold(GameItem, int, int, StoreClient)`、`SecData.CheckSoldChem` |
| `rent_due` | B1（另一条触发 `deficit_persisted` 可用） | `PlayerStore.PayRentCheck` / `GetRentDayCounter`；`RunStats.OnRentMissed` |
| `inspection_passed` / `inspection_failed` / `fine` | B6 | `RunStats.OnInspection(bool, int)`、`OnInspectedEvent` |
| `investigation_reset` | B6 | 未找到明确回调；不按数值下降推测 |
| `raid` | — | `RaidManager` |
| `evidence_removal_used` | B7 | 未定位 |
| `achievement:<id>` | B9a | `AchievementTracker`；“Say my name” 对应 ID 未知，`sayMyNameAchievementId` 为 null 时 B9a 关闭 |
| `store_bought` | B9b | `PlayerStore.BuyOutStore` / `OnStoreOwned`；`RunStats.OnStoreBoughtWithCash` |
| `game_over:<cause>` | BX | `PlayerStore.ExecuteGameOver(string)`、`GameOverEvent` |
| `story:mentor.introduction`、`story:ai.first_encounter` | 知识库剧透栅栏 | 未定位 |

中转 `game-world.mjs` 目前只放行 `rent_paid`、`kill:ai_controlled`、`item_bought` 三类读取器事件；读取器新增回调后，中转也要放行。

## 4. 剧本状态机（`season/script.ts`、`season/director.ts`）

- 节拍只由 `source: probably-stolen` 的世界观察或适配层派生事件推进；主播说“我被抄了”不会改变任何状态。
- 本季绑定到开局（B0）的那一局（`save` = 存档槽:runId）；其他局的事件不推进剧本。记仇本（BK）是贯穿线，任何一局的击杀都记。
- 节拍只能进入，不能回退；终幕或失败分支之后不再推进。B4–B7 需要先进入 B3（共犯线）。
- 每次推进写一条带出处的 Memory（或里程碑）；状态保存在实例快照的 `extensions['jingjing.season']`，按 `(世界事件 ID, 事件)` 去重，重启或重放不重复写入。
- 立场提示每条不超过 150 字（启动和测试时校验）。B5/B6/B7/BK 是一次性插曲，只在下一次回复时生效。

## 5. 每期流程

1. **开场**：一期中第一次对话时开启，注入开场账本，内容为上期通过审核的摘要、已结算或今日到期的 flag、记仇本新增条目、共犯里程碑。全部取自 Memory 和 commitments，只在本期第一轮注入。上一期的审核没有应用前，不开新一期。
2. **立 flag**：主播的话只由规则提出**候选**，不写入 commitments。
3. **收尾**：主播说“结束本期”，适配层生成 `<seasonDir>/review/EPxx.pending.json`，包含最多 5 条候选记忆（本期摘要、账面、本期共同经历）和本期 flag 候选。
4. **审核**：

```cmd
node examples/video-cohost/season/review-cli.ts ..\jingjing-overlay\data\season
```

   也可以直接修改 pending 文件，再放进 `inbox/`。CL 在下次同步时应用审核结果；候选文字以运行时保存的版本为准，文件只决定是否接受、截止天数和目标值。flag 必须填写截止天数（游戏天数，过了这一天仍未达成即判违约），无法用游戏数据判定的不收。

5. **结算**：每次收到快照时按 Situation 结算，例如在截止天数前资金达到目标即判为兑现。购买类 flag 遇到实际购买事件即判违约；截止后，只有读取器日志连续覆盖才判为兑现。

`seasonDir` 默认是 `jingjing-overlay/data/season`，可以用 `JINGJING_SEASON_DIR` 改。

## 6. 配方栅栏

`season/config.ts` 的 `recipeTerms` 是词表。适配层注入的世界上下文、知识库片段、运行时资料和季度记忆都会先脱敏；游戏物品名如果带有这些词，进入模型前替换为“〔略〕”。测试会检查每轮发给模型的 system 和 messages。人设边界写明“不讲配方、步骤或制法”。

## 7. 已知限制

- 第 3 节列出的缺失事件在实机中都不会触发。B3、B6、B7、B9a、B9b、BX 只在模拟回放中验证过。
- 模型的宽松记忆捕获（`memoryCapture: 'relaxed'`）仍然每轮即时写入，不经过收尾审核。这是 CL-010 的既有行为，录制前仍需主导者决定。
- 陪伴层通用的约定识别（`workspace` 的 `promiseText`）仍可能把主播的话登记为普通约定。这类约定按时间到期，不由游戏数据结算。
- 候选记忆和 flag 识别都基于规则，没有用模型生成。素材不足时，候选可能少于 3 条，不会补编。
- “结束本期”是制作控制口令，不推进剧本；语音识别误识别时可能提前收尾。
- 真实模型、实机游戏、浮窗联调均未实测。

## 8. 验证

```cmd
npm test
npm run typecheck
node --test --test-isolation=none tests/season/*.test.ts tests/jingjing-*.test.ts
```

模拟整局 fixture：`tests/season/fixtures/season-one-run.ts`；知识库测试替身：`tests/season/fixtures/knowledge.md`（自写，不含游戏文本）。
