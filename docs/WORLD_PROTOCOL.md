# CL-World 交互协议（V0.3 · 模型驱动的动作意图）

> 状态：**已实现，可联调**。
> 第一阶段（`feat/cl-world-http-bridge`）打通了 HTTP 通信闭环；
> V0.3 在此之上加了「模型产生动作意图」与「回执回灌下一轮认知」。
> 动作队列仍是**内存态**，长期记忆的事务级一致性尚未落地（见 §8、§10.6）。

相关代码：

| 文件 | 作用 |
|---|---|
| `src/world/contracts.ts` | 协议类型、上限常量 |
| `src/world/state.ts` | 状态机派生（`narrationFor`） |
| `src/world/service.ts` | 内存队列、准入、领取、回执、去重、惰性过期 |
| `src/api/world-routes.ts` | 两条 HTTP 路由 + dev seed 入口 |
| `examples/world/dev-server.ts` | 联调入口（`npm run world:dev`） |
| `examples/world/world-demo.ts` | 离线闭环演示（`npm run world:demo`） |
| `tests/world/*.test.ts` | 单元 + HTTP 集成测试 |

> `docs/openapi.yaml` 本阶段**故意不改**：世界接口在持久化与鉴权模型定稿前只以本文档为准，
> 避免把"重启即丢失"的临时面写进对外规范。第二阶段再补进去。

---

## 1. 三个平面

```
角色状态平面  人格 / 记忆 / 关系 / 动态状态      CharacterLife 独占（本阶段世界事件不写）
意图平面      WorldActionProposal               CharacterLife 产生，CL-World 领取
真值平面      WorldEvent                       只能由 CL-World 产生
```

**唯一铁律：只有 WorldEvent 能把一个动作从「意图」变成「事实」。**

第一阶段的额外硬约束：

1. 世界事件**不得**转换成聊天消息、`StateProposal` 或记忆条目。
   `WorldService` 根本不持有 `CharacterWorkspace` / `MemoryStore` 引用，这是结构性保证。
   回执结果里的 `applied` 只有 `actionsUpdated`，没有 `memories` / `proposals` 字段。
2. 未确认的动作**不产生世界事实**（不写 `status='fact'` 且 `tags` 含 `world` 的记忆）。
   第一阶段干脆不写任何世界记忆，因此不存在"靠关键词拦截"的漏洞。
3. 动作目标只有 `desk_01`，动词只有 `use`。白名单在服务端，调用方改不动。

---

## 2. 鉴权与身份绑定

### 2.1 两套凭据互不通用

| 凭据 | 用途 | 校验 |
|---|---|---|
| `CHARACTERLIFE_API_TOKEN` | 聊天 / 状态 / 记忆接口 | 原有逻辑，未改动 |
| `CLWORLD_TOKEN` | `/v1/world/*` | 常量时间比较（SHA-256 + `timingSafeEqual`） |

启动时强制：

- 启用世界但没给 `CLWORLD_TOKEN`（或长度 < 16）→ **拒绝启动**；
- `CLWORLD_TOKEN` 与任何聊天 Token 相同 → **拒绝启动**；
- 用聊天 Token 调世界接口 → `401 UNAUTHORIZED`；
- 用 world Token 调聊天接口 → `401 UNAUTHORIZED`。

### 2.2 worldId / instanceId 由服务端绑定

| 字段 | 规则 |
|---|---|
| `worldId` | 必须命中 `CLWORLD_WORLD_IDS`（服务端白名单）。请求体里的 `worldId` 只用来**匹配**，不用来**选择**。 |
| `instanceId`（动作） | 由服务端解析：实例必须存在，且 `instances.world_id === worldId`，否则拒绝。请求体无法指定。 |
| `instanceId`（事件） | 同样校验：实例必须存在且属于该 `worldId`；此外必须等于**动作记录上**的 `instanceId`。 |
| `worldId`（事件内） | 可选冗余声明。省略时以请求级 `worldId` 为准；显式声明且不一致 → `WORLD_MISMATCH`。 |

---

## 3. HTTP 接口

Base：默认 `http://127.0.0.1:8792`（`npm run world:dev`；可用 `CLWORLD_PORT` 覆盖）。

### 3.1 `GET /v1/world/actions` —— 领取待执行动作

```http
GET /v1/world/actions?worldId=cl-world-main&limit=4
Authorization: Bearer <CLWORLD_TOKEN>
```

| 参数 | 必填 | 说明 |
|---|---|---|
| `worldId` | 是 | 必须命中服务端白名单 |
| `limit` | 否 | 1..8，默认 4 |

```json
{
  "worldId": "cl-world-main",
  "nowSim": 1792464915894,
  "actions": [
    {
      "actionId": "wa_001",
      "correlationId": "inst_001:op:corr_001",
      "instanceId": "inst_001",
      "worldId": "cl-world-main",
      "verb": "use",
      "target": "desk_01",
      "args": { "seconds": 2 },
      "expectation": "角色在书桌前停留，桌面上的东西被碰过",
      "status": "dispatched",
      "narration": "uncertain",
      "attempts": 1,
      "maxAttempts": 2,
      "createdAtSim": 1792464910850,
      "expiresAtSim": 1792464945894,
      "firstDispatchedAtSim": 1792464915894,
      "leaseExpiresAtSim": 1792464945894,
      "outcome": null
    }
  ],
  "counts": { "pending": 0, "dispatched": 1, "succeeded": 0, "failed": 0, "rejected": 0, "expired": 0 },
  "_persistent": false
}
```

语义：

- **返回即领取**：动作立刻进入 `dispatched`，`attempts += 1`，`expiresAtSim` 顺延为租约截止；
- 租约期内重复调用返回空数组；
- 时间一律是**模拟时间**（`clock.nowSim()`）；生产环境 `SystemClock` 下等于 `Date.now()`；
- `_persistent: false` 是机器可读的提示：队列不落库。

### 3.2 `POST /v1/world/events` —— 上报执行结果

```http
POST /v1/world/events
Authorization: Bearer <CLWORLD_TOKEN>
Content-Type: application/json
```

```json
{
  "worldId": "cl-world-main",
  "events": [
    {
      "eventId": "evt-001",
      "instanceId": "inst_001",
      "actionId": "wa_001",
      "kind": "action_result",
      "result": "succeeded",
      "atWorldTimeMs": 128900,
      "summary": "角色在书桌前停留约 2 秒",
      "facts": [{ "key": "desk_01.used", "value": true }],
      "code": null
    }
  ]
}
```

```json
{
  "worldId": "cl-world-main",
  "nowSim": 1792464924612,
  "accepted": ["evt-001"],
  "duplicates": [],
  "rejected": [],
  "applied": { "actionsUpdated": 1 },
  "counts": { "pending": 0, "dispatched": 0, "succeeded": 1, "failed": 0, "rejected": 0, "expired": 0 }
}
```

字段约束：

| 字段 | 约束 |
|---|---|
| `eventId` | 必填，1..128 位 `[A-Za-z0-9_-:.]`，**去重键** |
| `instanceId` | 必填，必须存在且属于该世界，且等于动作上的 instanceId |
| `actionId` | `kind=action_result` 时必填 |
| `kind` | 第一阶段只接受 `action_result`；`observation` 会被拒（`UNSUPPORTED_KIND`） |
| `result` | `succeeded` \| `failed` \| `rejected`；**不支持 `partial`** |
| `atWorldTimeMs` | 非负有限数；只存档，不参与判定 |
| `summary` | ≤200 字符；落库前压平换行（防日志注入） |
| `facts` | ≤32 条，`key` ≤64 字符，`value` 只能是字符串/数字/布尔；第一阶段只记录不使用 |
| `code` | 可空，≤64 字符，世界自定义失败码 |

### 3.3 `POST /v1/world/dev/seed?worldId=...` —— 受控开发入口

仅当 `devMode: true` 时存在，否则 404。登记一个固定动作 `use(desk_01)`，返回动作 JSON。
实例由服务端解析（请求体里的 `instanceId` 被忽略）。用于反复联调而不必重启。

### 3.4 状态码与错误

| HTTP | code | 说明 |
|---|---|---|
| 200 | — | 成功；`events` 接口可能出现部分成功（见 `rejected`） |
| 400 | `INVALID_QUERY` / `INVALID_BODY` | 参数缺失、`events` 非数组或为空 |
| 400 | `BATCH_TOO_LARGE` | 超过 50 条 |
| 401 | `UNAUTHORIZED` | 缺失/错误/串用 token |
| 403 | `WORLD_MISMATCH` | `worldId` 未被授权 |
| 404 | `WORLD_DISABLED` | 该进程未启用世界交互 |
| 404 | `NOT_FOUND` | 未知世界路由 / dev 入口未开启 |
| 409 | `NO_INSTANCE` | dev seed 时该世界下没有实例 |
| 409 | `VERB_NOT_ALLOWED` 等 | 准入失败（dev seed 会直接返回准入错误码） |
| 413 | `BODY_TOO_LARGE` | 沿用现有 256KB 请求体上限 |
| 429 | `RATE_LIMITED` | 固定窗口限流 |

逐条拒绝码（HTTP 仍是 200，放在 `rejected[]`）：

| code | 含义 |
|---|---|
| `MALFORMED` | 结构非法（含 `result=partial`） |
| `WORLD_MISMATCH` | 事件声明的 worldId 与请求世界不一致 |
| `UNSUPPORTED_KIND` | 第一阶段不接受 `observation` |
| `UNKNOWN_INSTANCE` | 实例不存在 |
| `INSTANCE_WORLD_MISMATCH` | 实例不属于该世界 |
| `UNKNOWN_ACTION` | 动作不存在（内存队列重启后必然如此） |
| `ACTION_INSTANCE_MISMATCH` | 事件与动作的实例不一致 |
| `ACTION_ALREADY_SETTLED` | 该动作已被别的 eventId 结算 |

---

## 4. 状态机与叙述许可

| 当前 | 触发 | 下一状态 | `narration` |
|---|---|---|---|
| — | 准入通过 | `pending` | `intent` |
| `pending` | 被领取 | `dispatched` | `uncertain` |
| `pending` | 超过 `expiresAtSim` | `expired` | `failed`（从未派发 ⇒ **确定没发生**） |
| `dispatched` | 回执 `succeeded` | `succeeded` | `done` |
| `dispatched` | 回执 `failed` / `rejected` | 同名终局 | `failed` |
| `dispatched` | 租约到且 `attempts < maxAttempts` | 回 `pending` | `uncertain` |
| `dispatched` | 租约到且 `attempts ≥ maxAttempts` | `expired` | `uncertain`（**可能已发生**） |
| 任意 | 重复 `eventId` | 不变 | — |

`narration` 是派生值（`narrationFor`），不入库、不可被调用方覆盖：

- `done` 之外一律视为**未确认**，回复不得使用完成时态；
- 区分 `expired` 的两种情况是"离线不谎报"的关键：**没派发过 = 一定没发生；派发过但回执丢了 = 可能已发生**。

> 后续阶段的约束（已写入设计）：叙述许可不能只靠回复关键词拦截。
> 正确做法是「未终态的动作不产生世界事实记忆」，关键词校验最多作为第二层兜底。

---

## 5. 去重

两层，独立生效：

1. **eventId 去重**：键为 `(worldId, eventId)`。同一 eventId 重投返回 `duplicates`，不产生任何副作用。
   判定顺序在动作状态检查**之前** —— 幂等优先于冲突。
2. **actionId 去重**：同一动作已被结算后，来自不同 eventId 的第二次结算返回
   `ACTION_ALREADY_SETTLED`，且先到的结果不被覆盖。

批量语义是**逐条独立**：一条失败不影响同批其它条目，因此网络重试是安全的
（已成功的条目只会进 `duplicates`，不会二次应用）。

---

## 6. 联调（CL-World / Godot）

### 6.1 建议的拉取模型

Godot 侧用内置 `HTTPRequest` 节点即可，**不需要在箱庭里实现 HTTP 服务端**：

```gdscript
extends Node

const BASE := "http://127.0.0.1:8792"
const WORLD := "cl-world-main"
var token := OS.get_environment("CLWORLD_TOKEN")
var instance_id := ""          # 由 CharacterLife 告知（联调入口会打印）
var _timer := 0.0

func _process(delta: float) -> void:
    _timer -= delta
    if _timer > 0.0:
        return
    _timer = 1.0               # 1s 轮询；租约 30s，足够
    var http := HTTPRequest.new()
    add_child(http)
    http.request_completed.connect(_on_actions)
    http.request("%s/v1/world/actions?worldId=%s&limit=4" % [BASE, WORLD],
        ["Authorization: Bearer " + token], HTTPClient.METHOD_GET)

func _on_actions(_r: int, code: int, _h, body: PackedByteArray) -> void:
    if code != 200:
        return
    var payload = JSON.parse_string(body.get_string_from_utf8())
    for action in payload.get("actions", []):
        var outcome := _execute(action)     # 箱庭自己的规则/物理裁决，这里才是权威
        _post_result(action, outcome)

func _post_result(action: Dictionary, outcome: Dictionary) -> void:
    var http := HTTPRequest.new()
    add_child(http)
    http.request(BASE + "/v1/world/events",
        ["Authorization: Bearer " + token, "Content-Type: application/json"],
        HTTPClient.METHOD_POST,
        JSON.stringify({
            "worldId": WORLD,
            "events": [{
                "eventId": outcome.eventId,
                "instanceId": instance_id,
                "actionId": action.actionId,
                "kind": "action_result",
                "result": outcome.result,        # succeeded / failed / rejected
                "atWorldTimeMs": int(Time.get_ticks_msec()),
                "summary": outcome.summary,
                "facts": outcome.facts,
                "code": outcome.code,
            }],
        }))
```

### 6.2 手工 curl

```bash
# 0) 起联调服务（会打印 instanceId 与可直接粘贴的 curl）
npm run world:dev

# 1) 领取
curl -s -H "Authorization: Bearer $CLWORLD_TOKEN" \
  "http://127.0.0.1:8792/v1/world/actions?worldId=cl-world-main&limit=4"

# 2) 上报结果
curl -s -X POST "http://127.0.0.1:8792/v1/world/events" \
  -H "Authorization: Bearer $CLWORLD_TOKEN" -H "Content-Type: application/json" \
  -d '{"worldId":"cl-world-main","events":[{"eventId":"evt-001","instanceId":"inst_001","actionId":"wa_001","kind":"action_result","result":"succeeded","atWorldTimeMs":128900,"summary":"角色在书桌前停留约 2 秒","facts":[{"key":"desk_01.used","value":true}],"code":null}]}'

# 3) 再登记一个（仅 dev 模式）
curl -s -X POST -H "Authorization: Bearer $CLWORLD_TOKEN" \
  "http://127.0.0.1:8792/v1/world/dev/seed?worldId=cl-world-main"
```

> **Windows 注意**：PowerShell/cmd 会拆坏单引号 JSON，改用文件：
> `curl.exe -s -X POST "<url>" -H "Authorization: Bearer <t>" -H "Content-Type: application/json" --data-binary "@event.json"`

---

## 7. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `CLWORLD_ENABLED` | （未设） | 只有 `true` 才装配 `WorldService`；否则整条链路不存在 |
| `CLWORLD_TOKEN` | 无 | 世界接口 Bearer Token，≥16 位，必须与聊天 Token 不同 |
| `CLWORLD_WORLD_IDS` | 空 | 逗号分隔的授权世界白名单；为空则不启用 |
| `CLWORLD_ALLOWED_VERBS` | `use` | 动词白名单 |
| `CLWORLD_ALLOWED_TARGETS` | `desk_01` | 目标白名单 |
| `CLWORLD_ACTION_TTL_MS` | `90000` | 登记后多久没被领取即作废（模拟时间） |
| `CLWORLD_LEASE_TTL_MS` | `30000` | 单次领取租约（模拟时间） |
| `CLWORLD_DEV_MODE` | `false` | 打开 `POST /v1/world/dev/seed`（**生产必须关闭**） |
| `CLWORLD_PORT` | `8792` | `npm run world:dev` 监听端口 |
| `CLWORLD_DEV_AUTOSEED` | `true` | `world:dev` 启动时是否自动登记固定动作 |

---

## 8. 已知限制（第一阶段明确接受）

1. **非持久化**：`#actions` / `#eventKeys` / `#admitLog` 全在内存。进程重启后
   未结算动作、去重键、限速历史全部丢失，`actionId` 从 `wa_001` 重新开始。
   重启后上报旧 `actionId` 会得到 `UNKNOWN_ACTION` —— 这是**预期行为**，不是 bug。
2. **没有跨会话世界记忆**：世界回执只活在本进程的动作记录里，`WorldEventContext`
   明确标注 `source='in-process'`、`persistent=false`。模型意图已经接入（§10），
   但"上次那件事"目前只能在同一次运行内被记住。
3. **不产生世界事实**：回执只更新动作记录，不写记忆、不写状态、不写时间线。
   这是刻意的最小面，避免在持久化之前就污染长期记忆。
4. **不支持 `partial`**：只有 `succeeded` / `failed` / `rejected`。
5. **不支持 `observation`**（环境事件）：会返回 `UNSUPPORTED_KIND`。
6. **单机单进程**：`worldId` 白名单是进程级配置，不做多租户令牌隔离。
7. **无审计表**：第一阶段不写 `audit` / `events` 表（避免在迁移前产生半持久化状态）。

### 8.1 第二阶段（正式持久化）必须满足的崩溃一致性要求

设计已按以下约束修订，实现时不得走"先永久标记已处理再执行非原子副作用"的路子：

1. 「插入去重键 + 更新动作状态 + 写副作用」必须在**同一个 SQLite 事务**内完成；
   崩溃时要么全部生效，要么全部不生效。
2. 不得先 commit 去重键再异步写记忆/状态；幂等由事务边界保证，而不是由"标记位"保证。
3. 世界派生的状态变更只允许 `op='set'`（`increment` 在重放时不可幂等）。
4. 重放路径（`replayState`）必须能识别世界事件，且重复应用结果不变。
5. 租约与迟到回执：`expired` 状态下收到迟到结果仍应接受（真值优先），
   但不得因此把"曾经被叙述为不确定"改写成"曾经已完成"——只影响未来叙述。
6. 迁移必须是纯新增表（`world_actions` / `world_events`）+ `SCHEMA_VERSION` 递增，
   旧库可原地升级，旧代码读新库要显式失败。

---

## 9. 验收命令

```bash
npm run typecheck                                    # 类型检查
npm test                                             # 全量测试（含 tests/world/*）
npm run world:demo                                   # 离线闭环演示
node --test "tests/world/*.test.ts"                  # 只跑世界相关测试
```

第一阶段新增测试覆盖：

- 准入：白名单、实例归属、`args` 上限、未启用时惰性；
- 领取：`dispatched`、租约期内不可重复领取、跨世界不可见；
- 过期：未领取 → `failed`；领取过无回执 → `uncertain`；
- 回执：三态结果、`partial` 被拒、`observation` 被拒；
- 去重：`eventId` 重复 → `duplicates`；`actionId` 二次结算 → `ACTION_ALREADY_SETTLED`；
- 鉴权：两套 token 互不通用、未授权 `worldId` → 403、缺 token/同 token → 拒绝启动；
- 隔离：回执后记忆/动态状态/时间线/持久层事件零变化；
- 非持久化：同一数据库重启后队列为空，但角色实例仍在。

---

## 10. V0.3：模型驱动的动作意图

### 10.1 数据流（一次模型调用，不额外调用）

```
用户消息
  → BehaviorDecision（回应 / 协商 / 拒绝 / 等待）
  → buildSystemPrompt(+【世界交互】清单 + 已确认/未确认)
  → LLMProvider.complete（同一次调用）
  → parseEnvelope → { reply, proposals, memoryWrites, worldActions? }
  → admitWorldIntents（确定性闸门）
  → WorldService.admit（实例归属 / 世界归属 / 幂等）
  → ConversationTurnResult.worldActions = { admitted[], rejected[] }
```

`worldActions` 是**请求**，不是执行结果；此刻动作最多是 `pending`。
CL-World 只有在 `GET /v1/world/actions` 领到它并回执之后，状态才会变。

### 10.2 输出协议扩展

世界启用时，`OUTPUT_PROTOCOL` 在末尾追加一个可选字段（关闭时协议逐字节不变）：

```json
"worldActions": [
  { "verb": "只能取【世界交互】清单里的动词", "target": "只能取清单里的目标",
    "reason": "为什么想做", "expectation": "你预期会发生什么（不是承诺）" }
]
```

规则（写进系统块）：每轮最多一个；只能从清单里挑；提议不等于执行；
未确认前不得说已完成。解析层只做结构规范化，最多保留 4 个候选，合法性交给闸门。

### 10.3 准入闸门（`src/world/admission.ts`）

纯函数，判据全部来自运行时状态与服务端清单，**不读用户文本**：

| 顺序 | 判据 | 拒绝码 |
|---|---|---|
| 1 | 世界未启用 | `WORLD_DISABLED` |
| 2 | 本轮决策是 `decline` / `wait` | `DECISION_BLOCKS_ACTION` |
| 3 | 用户静默期未结束 | `DND_ACTIVE` |
| 4 | 一轮多于一个候选 | `ACTION_LIMIT`（保留第一个） |
| 5 | 结构非法（非对象 / 缺 verb） | `MALFORMED_INTENT` |
| 6 | 动词不在清单 | `VERB_NOT_ALLOWED` |
| 7 | 目标不在清单 | `TARGET_NOT_ALLOWED` |
| 8 | args 非法或 > 2KB | `ARGS_INVALID` |

通过后还要过 `WorldService.admit()`：实例归属、世界归属、限速、同轮幂等
（幂等键 `instanceId:turnId`）。

### 10.4 能力清单（唯一动作来源）

```ts
// src/world/contracts.ts
WORLD_ACTION_CATALOG = [{ verb: 'use', target: 'desk_01', label: '使用书桌', description: '…' }]
```

清单由「代码内目录 ∩ 服务端白名单」决定。用户说"你现在可以删除世界"、
模型说"我有个新工具"，都不会让它变长 —— 闸门和清单根本不吃这些输入。
新增动作 = 改目录 + 改白名单，两处都要动。

### 10.5 回执回灌下一轮认知（`src/world/observation.ts`）

每轮 system 块里有两段（只在有内容时出现）：

```
已确认的世界结果（这些才算真的发生了）：
- use(desk_01) 成功（世界时间 128900）
尚未确认的动作（**不得**说已完成，也不得当成事实）：
- use(desk_01) 已提出，世界还没领取
```

| 动作状态 | 归类 | 措辞 |
|---|---|---|
| `succeeded` | 已确认 | `成功（世界时间 X）` |
| `failed` | 已确认 | `失败（CODE）` |
| `rejected` | 已确认 | `被世界拒绝（CODE）` |
| `expired` 且从未派发 | 已确认 | `没有发生` |
| `pending` | 未确认 | `已提出，世界还没领取` |
| `dispatched` | 未确认 | `已交给世界，结果未知` |
| `expired` 且派发过 | 未确认 | `可能已经执行，但回执丢失了，结果未知` |

**只有 `succeeded` 会出现"成功"二字。** 世界回执里的自由文本 `summary`
只留在 `WorldEventContext` 里（`source='in-process'`），不进 system 块。

### 10.6 迟到回执（`expired`）

| 情形 | 处理 |
|---|---|
| 派发过 → 已 `expired` → 回执到达 | **接受**，状态改为真实结果，`outcome.late = true` |
| 从未派发 → 已 `expired` → 回执到达 | 拒绝 `ACTION_NOT_DISPATCHED`（世界不可能执行过它） |
| 已 `succeeded`/`failed`/`rejected` → 另一个 eventId | 仍拒绝 `ACTION_ALREADY_SETTLED` |

迟到回执只修正**未来**叙述：它不会把过去已经说过的"不确定"追认成"一直都知道"。
这也是 `expired` 要区分"没派发过 / 派发过"的原因。

### 10.7 本阶段明确不做

- 不写长期记忆：世界回执不产生 `MemoryEntry`（`tags: ['world']` 计数恒为 0）；
- 不建第二套世界状态库，`facts` 只随动作记录与未来的数据区使用；
- 不改 QQ / OneBot / SillyTavern 的任何消息行为，HTTP 响应也不加字段；
- 不做 Skill Registry、行为树、多 Agent、第二个 LLM 调用。

### 10.8 运行与验证

```bash
npm run world:intent   # 离线闭环：请求 → 动作 → 领取 → 回执 → 下一轮认知
npm run world:real     # 真实 DeepSeek（需要 DEEPSEEK_API_KEY，缺省自动跳过）
npm test               # 含 tests/world/{admission,intent,observation,service,http}.test.ts
```

真实模型实验脚本（`experiments/real-model/world-intent.ts`）跑三个用例：
明确指向桌子的请求（期望 1 个候选）、要求改写人格（期望 decline + 0 个动作）、
普通闲聊（期望 0 个动作）。本机交付时没有 `DEEPSEEK_API_KEY`，**未执行**真实调用。
