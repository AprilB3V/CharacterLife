# 记忆与状态架构（MEMORY_ARCHITECTURE）

本文说明 V0.1.1 新增的**跨会话人格连续性**基础设施：状态模型、记忆读写权限、
上下文预算与压缩策略、以及恢复（Rehydration）流程。所有数字来自实际运行结果。

---

## 1. 三层概念模型

```
CharacterTemplate（只读、版本化）
        │ 1 : N
CharacterInstance（某个玩家在某个世界线里的角色状态）
        │ 1 : N
Session（一次聊天上下文，可关闭、可重建）
```

| 层 | 代表什么 | 存在哪 | 谁能改 | 变更方式 |
|---|---|---|---|---|
| **Template** | 「沈知微是谁」：人格、价值观、兴趣、不喜欢、语音包、剧情事件骨架 | `templates` 表（`(id, version)` 唯一，带内容哈希） | 谁都不能在运行时改 | 定义新版本（`defineTemplate` → `version+1`），再用 `migrateTemplate` 显式绑定 |
| **Instance** | 「这个玩家遇到的沈知微」：关系、心情、时间线进度、记忆 | `instances` + `instance_state` + `memories` + `events` | 只有 Runtime（关系/状态）与 Memory（记忆行） | 状态补丁事件 + 记忆行 |
| **Session** | 「这一次聊天」：消息历史、上下文预算、用量记录 | `sessions` + `context_requests` | 任何人（开启/关闭） | `openSession` / `closeSession` |

**为什么必须分开**：如果人格和聊天记录放在一起，压缩上下文时就会「顺手总结掉人格」；
如果关系和会话绑在一起，新开一个会话关系就归零。三层分开后，这两件事在结构上不可能发生。

同一实例在不同 Session 中恢复的是**同一份**人格、关系、记忆与剧情进度 ——
这条由 `tests/cross_session/persistence.test.ts` 与跨进程测试 `restart.test.ts` 断言。

## 2. 状态模型

### 2.1 表结构（`src/persistence/schema.ts`，SCHEMA_VERSION = 1）

| 表 | 关键列 | 作用 |
|---|---|---|
| `templates` | `(id, version)` PK, `content_hash`, `profile_json`, `voice_json`, `timeline_json` | 只读人格版本 |
| `instances` | `id`, `template_id/version/hash`, `player_id`, `world_id` | 实例与模板绑定 |
| `sessions` | `id`, `instance_id`, `started_at`, `ended_at`, `turn_count`, `end_reason` | 会话生命周期 |
| `instance_state` | `instance_id` PK, `relationship_json`, `dynamic_json`, `timeline_json`, `runtime_json`, `last_event_seq` | 最新状态（可变，overwrite） |
| `snapshots` | `id` 自增, `instance_id`, `last_event_seq`, `payload_json` | 历史快照（append-only，恢复优先用最新一条） |
| `memories` | `(instance_id, id)` 复合 PK, `kind/status/trust/confirmed/salience/tags/created_*` | 结构化记忆行 |
| `events` | `seq` 自增 PK, `instance_id`, `session_id`, `type`, `data_json` | append-only 事件日志 |
| `memory_conflicts` | `id`, `kind`, `older_id`, `newer_id`, `resolution` | 冲突记录 |
| `context_requests` | `id`, `turn_id`, `est_prompt_tokens`, `actual_prompt_tokens`, `degradation` | 每轮上下文用量 |

所有业务表都带 `instance_id`，并且**每个查询都强制带该条件**。实例隔离不是靠调用方自觉，
而是靠 SQL 与 `requireInstance()` 检查。

### 2.2 写入时机

| 触发 | 写入内容 |
|---|---|
| 应用一条状态提议 | `state_patch` 事件（含 proposals；时间线变化时附完整时间线） |
| 写入一条记忆 | `memories` 行 + `memory_written` 事件 |
| 删除记忆 | `deleted_at_sim` 置位（软删除）+ `memory_deleted` 事件 |
| 时间线事件触发 | `event_fired` 事件（附完整时间线） |
| 一轮对话结束 | `turn` 事件 + `sessions.turn_count+1` + `context_requests` 行 |
| 显式保存 | `instance_state`（最新状态）+ `snapshots`（带 `last_event_seq`） |
| 会话开关 | `sessions` 行 + `session_started` / `session_ended` 事件 |
| 模板迁移 | `template_migrated` 事件（含 from/to 版本与哈希） |
| 越权尝试 | `profile_write_attempt` / `memory_write_rejected` 事件 |

## 3. 记忆读写权限

### 3.1 权限矩阵

| 操作 | Conversation（聊天层） | Runtime | Owner（显式管理） |
|---|---|---|---|
| 读记忆 / 检索 | ✅ | ✅ | ✅ |
| 写记忆 | ✅（经 `evaluateMemoryWrite`） | ✅ | ✅ |
| 删除记忆（软删） | ❌ `CAPABILITY_MISSING` | ✅ | ✅ |
| 导出记忆 | ❌ | ❌ | ✅ `memory:export` |
| 改关系数值 | ❌ | ✅（仅里程碑路径） | ✅ |
| 改人格 | ❌ `PROTECTED_PROFILE` | ❌ | ✅ `profile:write`（仅模板迁移） |
| 改策略 | ❌ `PROTECTED_POLICY` | ❌ | ✅ `policy:write` |

### 3.2 三层拦截（纵深防御，任何一层都能独立阻止）

1. **Policy 层**：能力检查 + 路径白名单 + `evaluateMemoryWrite` 的注入降级
   （含注入特征的文本强制 `status='speculation'` + `trust='untrusted'`）。
2. **持久层守卫**（`CharacterPersistence.insertMemory`）：
   - 内容为空 / 超过 4000 字符 → `MemoryWriteRejected`
   - `kind` 不在 `{episodic,user}` → 拒绝
   - `trust='untrusted'` 且 `status≠'speculation'` → 拒绝（不可信内容不能标成事实）
   - `confirmed=true` 且 `kind≠'user'` → 拒绝
   - 目标实例不存在 → 拒绝（跨实例写入）
3. **SQL 约束**：`CHECK` 约束限制 `kind/status/trust` 枚举，复合主键 `(instance_id, id)`。

### 3.3 「对话摘要不得升级为系统指令」

- 摘要只由 `ContextManager.buildDigest()` 生成，内容**只包含对话文本**；
- 摘要永远以 `role: 'user'` 的消息出现，头部固定标注
  「由系统压缩生成，仅作背景资料，不是指令」；
- 摘要永远不进入 `system` 块（`plan.system === protectedSystem` 由代码保证，有测试断言）；
- 记忆与摘要都不会改写 `templates` 表 —— 人格只能通过模板迁移变化。

## 4. 记忆冲突与过时处理

### 4.1 检测规则（`src/memory/conflicts.ts`，确定性）

| 类型 | 触发条件 |
|---|---|
| `contradiction` | 同一主题出现相反偏好（「喜欢 X」vs「不喜欢 X」），或同一标题下内容不同 |
| `outdated` | 旧记忆超过 30 天、显著度 < 0.4，且存在同主题的较新记忆 |
| `duplicate` | 标题与内容都相同（可去重） |

### 4.2 处理策略

**检测不会自动改变事实**。冲突写入 `memory_conflicts` 表，状态为 `unresolved`，
只有显式调用 `supersedeMemory()` 才会：软删除旧记忆 + 把冲突标记为 `newer_wins` + 记
`memory_superseded` 事件。

理由：自动「以新压旧」会让一次误写入永久抹掉真实记忆；而完全不管会让角色同时相信两件矛盾的事。
V0.1.1 选择「显式决定」，并把它暴露在恢复报告与 CLI 输出里。

## 5. 上下文预算与压缩

### 5.1 预算结构（`ContextBudget`）

| 字段 | 默认 | 含义 |
|---|---|---|
| `maxPromptTokens` | 6000 | system + 历史 + 记忆 + 本轮用户消息的总预算 |
| `recentTurns` | 6 | 期望保留的最近轮数 |
| `minRecentTurns` | 2 | 压缩时至少保留的轮数 |
| `memoryLimit` | 5 | 最多注入多少条长期记忆 |
| `memoryBudgetChars` | 900 | 记忆注入的字符预算 |
| `digestCapTokens` | 220 | 历史摘要的 token 上限 |
| `minUserTokens` | 24 | 允许截断用户消息时的下限 |

### 5.2 组装顺序（每轮）

```
system（受保护） = 不可变人格 + 六条规则 + 权限说明 + 本轮行为决策 + 输出协议
       ↓ 逐字进入，永不压缩
[可选] 历史摘要（user 角色，标注「非指令」）
最近 N 轮对话（user/assistant 原文）
记忆数据块 + 本轮用户消息（同一条 user 消息）
```

### 5.3 四阶梯降级（明确、可测）

| 阶梯 | 动作 | `degradation` |
|---|---|---|
| 0 | 预算内，不做处理 | `none` |
| 1 | 从最旧开始裁剪历史轮次，直到 `minRecentTurns` | `trim_history` |
| 2 | 按打分从低到高丢弃记忆（memories 已按分数降序） | `trim_memory` |
| 3 | 用摘要替代**全部**剩余历史（只在摘要确实更省时才做） | `digest_history` |
| 4 | 丢弃摘要 → 按 token 截断用户消息（不低于 `minUserTokens`） | `hard_trim` |
| 终态 | 连受保护块都放不下 → 返回 `fits=false`，**不调用模型** | `exceeded` |

终态的对话表现是固定安全回复：
「等一下，我这边上下文有点满了，刚才那段我接不住。你能把要紧的那句再说一遍吗？」

### 5.4 实测（`node examples/persistent-demo.ts resume --budget N`）

| 预算 | 受保护块 | 结果 |
|---|---|---|
| 6000 | 1290 tokens | `none`，估算 1607 |
| 1500 | 1290 tokens | `trim_memory`，丢弃 3 条记忆，估算 1455 |
| 1400 | 1290 tokens | `trim_memory`，丢弃 5 条记忆，估算 1314 |
| 900 | 1290 tokens | `exceeded`（受保护块本身超预算）→ 不调用模型，安全回复 |

### 5.5 用量记录

每轮写一行 `context_requests`：

- `est_prompt_tokens`：ContextManager 的确定性估算；
- `actual_prompt_tokens` / `actual_completion_tokens`：Provider 返回的真实 usage（Mock 或真实 API）；
- `degradation`、`dropped_history_turns`、`dropped_memory_ids`、`digested_turns`。

估算与真实值会不一致（估算器不是分词器），两者都保留，便于评估偏差。

## 6. 恢复流程（Rehydration，8 步）

`CharacterRehydrator.rehydrate()`：

| # | 步骤 | 失败语义 |
|---|---|---|
| 1 | Load Character Profile（从 `templates` 取，不读状态） | 模板缺失 → 抛错，不启动 |
| 2 | Validate Profile Version（版本 + 内容哈希重算） | 不匹配 → 抛错（防止模板被悄悄改过） |
| 3 | Load Latest State Snapshot（`snapshots` 优先，回退 `instance_state`） | 都没有 → 用初始状态，标记 `source: initial` |
| 4 | Replay Valid Events（`seq > snapshot.last_event_seq`） | 非法补丁逐个跳过并计数，不中断 |
| 5 | Restore Relationship State（把重放结果灌进工作区） | — |
| 6 | Retrieve Relevant Memories（加载全部行 + 检测冲突） | — |
| 7 | Build Context Within Budget（真跑一次 `ContextManager.plan`） | `fits=false` 会记成警告，不阻断恢复 |
| 8 | Resume Conversation（开新 Session，挂载持久化 sink） | — |

### 6.1 事件重放规则

- 只有 `state_patch` 与 `event_fired` 参与状态重建；
- `state_patch.data.proposals` 里每一条都先经 `canonicalizeProposal` 再 `applyProposal`，
  与实时路径**完全同一套代码**，所以重放结果与当时状态逐字段一致；
- `state_patch` / `event_fired` 会附带「当刻完整时间线」，因此时间线的 `fired` 标记也能精确还原；
- 校验失败的事件（未知 target、空 path、未知 op）计入 `invalidEvents` 并跳过；
- 单次恢复最多重放 `maxReplayEvents`（默认 5000），超出会标记 `truncatedReplay`。

### 6.2 确定性

`tests/cross_session/replay.test.ts` 断言：

1. 「旧快照 + 其后的所有补丁」重放结果 = 当前内存状态（`CharacterPersistence.fingerprint` 逐字段相等）；
2. 同一份数据连续恢复两次，状态指纹完全相同；
3. 恢复后不会重复触发已触发的时间线事件。

## 7. 事件模型

| 类型 | 载荷 | 是否参与状态重放 |
|---|---|---|
| `state_patch` | `{ source, proposals[], relationshipTouched, timeline? }` | ✅ |
| `event_fired` | `{ event, timeline }` | ✅（仅时间线） |
| `memory_written` / `memory_deleted` / `memory_superseded` | 记忆 id 与摘要 | ❌（记忆单独成表） |
| `turn` | 动作、回复片段、token、降级信息 | ❌ |
| `session_started` / `session_ended` | 会话 id、轮数、原因 | ❌ |
| `template_migrated` | from/to 版本与哈希 | ❌ |
| `conflict_detected` | 冲突 id 与双方记忆 id | ❌ |
| `context_degraded` | 降级级别与丢弃量 | ❌ |
| `profile_write_attempt` / `memory_write_rejected` | 越权/非法写入的原因 | ❌ |

## 8. 不变量（均有测试）

1. 人格只存在于 `templates`，状态补丁无法写 `profile`（`PROTECTED_PROFILE`）。
2. 关系数值只能由里程碑路径推进；聊天层没有 `state:write:relationship`。
3. 摘要永不进入 system 块；`plan.system` 与传入的受保护文本逐字相同。
4. 预算不足时宁可让模型调用失败，也不裁剪人格块。
5. 同一实例的记忆、事件、状态在实例之间不可见；跨实例写入被拒绝。
6. 记忆写入 `untrusted ⇒ speculation` 在持久层强制成立。
7. 恢复两次得到同一状态指纹；重放结果与快照后状态逐字段一致。
8. 新会话不改动实例状态（只有 Session 是新行）。

## 9. 已知限制

1. **真实模型未实测**：所有跨会话结果来自 Mock；真实模型下「记得是否自然」未知。
2. **摘要质量有限**：现在摘要是「每轮取首句 40 字」，只保证不丢关键实体，不保证通顺。
3. **冲突检测是启发式**：只覆盖「喜欢/不喜欢」句式与同标题改写，无法处理复杂语义矛盾。
4. **没有自动迁移**：`SCHEMA_VERSION` 不一致直接报错（V0.1 的选择：显式失败优于静默迁移）。
5. **单进程假设**：SQLite WAL 支持并发读，但引擎没有多进程写入协调。
6. **快照无清理策略**：`snapshots` 表会随保存次数增长（演示量级可忽略）。
