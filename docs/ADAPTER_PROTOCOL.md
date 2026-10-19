# 适配器协议（Adapter Protocol）

本文说明 V0.2 接入层的契约：外部平台怎么接进来、哪些东西平台**不能**碰、以及给新平台
（Telegram / Discord / Godot / Unity …）写适配器时要实现什么。

## 1. 数据流

```
外部平台事件 / HTTP 请求
        │
        ▼
PlatformAdapter.parseInbound()          ← 只做协议翻译（平台 SDK 只出现在这里）
        │  NormalizedMessage
        ▼
MessageGateway.handleMessage()          ← 去重 / 限流 / 身份 / 每实例互斥
        │
        ├─ 指令（/help /status …）→ 直接回复，不调用模型
        │
        ▼
InstanceRuntimeManager                  ← 一个实例一份 workspace（唯一真相）
  ├─ CharacterWorkspace（关系 / 时间线 / 决策）
  ├─ MemoryStore（结构化记忆）
  ├─ ContextManager（预算与压缩）
  └─ SQLite（快照 + 事件 + 记忆）
        │
        ▼
PlatformAdapter.send()                  ← 只做发送；失败返回结构化错误
        │  MessageDeliveryResult
        ▼
外部平台
```

**平台侧永远拿不到数据库句柄和 workspace**，只能通过 Gateway。

## 2. 核心类型（`src/adapters/protocol.ts`）

```ts
interface NormalizedMessage {
  platform: string
  platformMessageId: string        // 去重键
  identity: PlatformIdentity       // { platform, platformUserId, displayName? }
  scene: 'c2c' | 'group' | 'guild' | 'dm' | 'local'
  sceneId: string | null
  text: string
  timestamp: number
  replyTarget: string              // 适配器自定义的不透明串
  replyToMessageId: string | null
  trust: 'untrusted'               // 恒定：外部输入一律不可信
  raw: Record<string, unknown>
}

interface PlatformCapabilities {
  proactive: boolean               // 能否主动推送（默认 false）
  replyWindowMs: number            // 被动回复窗口（0 = 不限）
  maxRepliesPerMessage: number     // 单条消息最多回复几次（0 = 不限）
  streaming: boolean
  webhookSignature: boolean
}

interface PlatformAdapter {
  readonly platform: string
  readonly capabilities: PlatformCapabilities
  parseInbound(raw: unknown): NormalizedMessage | null   // null = 不是消息事件
  send(message: OutboundMessage): Promise<MessageDeliveryResult>
}

interface MessageDeliveryResult {
  ok: boolean
  platformMessageId: string | null
  queued: boolean                  // true = 没发出去，进 CharacterLife 队列
  error: { code: 'NO_PERMISSION' | 'WINDOW_EXPIRED' | 'RATE_LIMITED'
                 | 'PLATFORM_ERROR' | 'NOT_SUPPORTED'
           message: string; retryable: boolean } | null
  latencyMs: number
}
```

约定：

1. `parseInbound` 遇到**不认识的事件返回 `null`**（不要抛），遇到**坏数据抛 `InboundParseError`**；
2. `send` 永远不抛异常，失败用 `MessageDeliveryResult.error` 表达；
3. `queued: true` 表示「平台发不出去」，Gateway 会把内容放回待发送队列，下次用户来信时自然提起；
4. `capabilities` 是**声明式**的：没声明的能力就不要用（宁可不发，也不要绕过平台限制）。

## 3. 身份与绑定

- `platform_identities(platform, platform_user_id) → instance_id`：一个平台身份只能指向一个实例；
- 同一实例可被**多个平台身份**绑定（QQ + 酒馆共用同一个角色）；
- 当前的 `platform` 取值：`qq`（官方机器人）、`onebot`（OneBot 11 网关）、`sillytavern`；
- 绑定只能通过**一次性验证码**完成：

```
QQ: /bind  →  8 位数字码（5 分钟有效、最多 3 次尝试、只存 sha256）
酒馆: POST /v1/identity/redeem { code }  →  绑定到同一实例
```

不允许：根据昵称推断同一个人、知道 instanceId 就获得访问权、静默改绑。

## 4. 并发与一致性

- **一个实例一把锁**（`InstanceRuntimeManager.withLock`）：QQ 与酒馆同时发消息时串行处理，
  不会出现「两边各写一半状态」；
- 一个实例在进程内只有**一份 workspace**（否则两个平台会看到不同的关系数值）；
- 每个平台身份有**独立的会话历史**（`histories`），所以新会话不会串台；
- 每次处理完写一份状态快照（`saveSnapshot`），崩溃后最多丢当前这一轮。

## 5. 指令

`/help`、`/status`、`/newsession`、`/memory`、`/forget`、`/quiet`、`/bind`、`/unbind`。
未知 `/xxx` 当作普通消息处理（不吞用户输入）。指令**不调用模型**。

## 6. HTTP API（给酒馆或自建前端用）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 健康检查（无鉴权） |
| GET | `/v1/models` | OpenAI 模型列表 |
| POST | `/v1/chat/completions` | OpenAI Chat Completions（支持 `stream: true`） |
| POST | `/v1/messages` | 原生消息（返回 reply + 状态摘要） |
| POST | `/v1/sessions` | 新开会话（保留长期记忆） |
| GET | `/v1/characters/:id/state` | 公开状态（只能看自己绑定的实例） |
| GET | `/v1/characters/:id/memories` | 个人记忆列表 |
| DELETE | `/v1/memories/:id` | 删除一条记忆（软删除） |
| GET | `/v1/identity/me` | 当前平台身份 |
| POST | `/v1/identity/bind-code` | 签发一次性绑定码 |
| POST | `/v1/identity/redeem` | 消费绑定码 |
| DELETE | `/v1/identity/binding` | 解绑 |

完整请求/响应结构见 [`openapi.yaml`](openapi.yaml)。

安全基线：

- Bearer Token（≥8 位，常量时间比较），未配置直接拒绝启动；
- 默认只监听 `127.0.0.1`；非回环需要显式 `allowNonLoopback`；
- 请求体上限 256 KB，每 Token 限流 120 请求/分钟；
- 日志只记方法/路径/状态/耗时，不记正文与 token；
- 外部传来的 `system` / `developer` 内容**不会**成为人格或权限规则。

## 7. 写一个新平台适配器（7 步）

1. 新建 `src/adapters/<platform>/`；
2. 实现 `parseInbound`：把平台事件映射成 `NormalizedMessage`（`platformMessageId` 必须稳定）；
3. 实现 `send`：把 `OutboundMessage` 发出去，失败返回 `MessageDeliveryResult`；
4. 声明 `capabilities`（保守：没有把握的能力写 `false` / `0`）；
5. 在 `src/api/runtime-factory.ts` 里注册（或由使用方 `gateway.registerAdapter()`）；
6. 写测试：事件解析、去重、非法输入、发送失败降级、人格不被覆盖（参考 `tests/adapters/qq.test.ts`）；
7. 在 `docs/` 补一份平台能力核查（参考 `QQ_CAPABILITIES.md` 的「已验证 / 未验证」格式）。

不需要改引擎的任何代码 —— 这是本层存在的意义。

> 两个现成的范例，按需要挑一个当模板：
> - `src/adapters/qq/`：官方签名的 Webhook（服务写在 `examples/qq-bot/server.ts`）；
> - `src/adapters/onebot/`：OneBot 11（**上报服务也放在 `src/adapters/` 里**，因此可以用真实
>   HTTP 端口做端到端测试，见 `tests/adapters/onebot-http.test.ts`）。需要「服务本身可测」时
>   请照 OneBot 这个结构写，而不是照 QQ 的 examples 结构。

## 8. 已知边界

| 项 | 现状 |
|---|---|
| QQ 官方机器人 | 已实现（Webhook + Ed25519 验签；真实联调未执行） |
| OneBot 11（NapCat / Lagrange / SnowLuma） | 已实现（HTTP 上报 + HTTP API，仅文本；真实网关联调未执行） |
| Telegram / Discord | 未实现（协议已就绪） |
| 图片 / 语音 / 视频 | 未实现（OneBot 侧转成 `[图片]` `[语音]` 占位符进引擎） |
| 多进程部署 | 未实现（进程内锁 + SQLite 单写者） |
| 主动消息调度器 | 未实现（队列在 workspace 里，靠用户来信带走；OneBot 能在来信时先推送一条） |
