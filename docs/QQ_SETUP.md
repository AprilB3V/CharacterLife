# QQ 官方机器人接入步骤（本项目实现）

> 本文只写「拿到凭证之后怎么做」。能力边界与未验证项见 [`QQ_CAPABILITIES.md`](QQ_CAPABILITIES.md)。

## 0. 前置条件

| 项 | 要求 |
|---|---|
| Node.js | ≥ 22.6（本项目实测 26.7.0） |
| QQ 开放平台账号 | 已创建机器人应用，拿到 `AppID` / `AppSecret` |
| 场景权限 | 后台勾选并审核通过（单聊 / 群聊 / 频道 视你需要） |
| 回调地址 | Webhook 模式需要公网可达（内网穿透也行）+ 允许的 IP |

没有凭证也可以先跑离线演示：

```powershell
node examples/qq-bot/demo.ts
```

## 1. 配置环境变量

复制 `.env.example` 为 `.env`（本项目不自动加载 .env，请用系统环境变量或 shell 注入）：

```powershell
$env:QQBOT_APP_ID     = "你的 AppID"
$env:QQBOT_APP_SECRET = "你的 AppSecret"
$env:QQBOT_WEBHOOK_PORT = "8788"
$env:QQBOT_PROACTIVE  = "false"     # 没有主动消息额度就保持 false
$env:CHARACTERLIFE_DB = "data/characterlife.db"
$env:DEEPSEEK_API_KEY = "sk-..."    # 可选，不填则用 MockProvider
```

## 2. 启动 Webhook 服务

```powershell
node examples/qq-bot/server.ts
```

输出：

```
QQ Webhook 监听 http://127.0.0.1:8788/qq/webhook
```

服务做了三件事：

1. `op=13` 回调地址校验：用 AppSecret 派生 ed25519 私钥签名 `plain_token`；
2. 普通事件：校验 `X-Signature-Ed25519` + `X-Signature-Timestamp`，失败一律 401；
3. 交给 Gateway：去重 → 身份 → 角色实例 → 引擎 → 官方发送接口。

## 3. 在开放平台配置回调

1. 机器人后台 → 开发设置 → 事件订阅（Webhook）；
2. 回调地址填 `https://<你的域名或穿透地址>/qq/webhook`；
3. 订阅需要的事件：`C2C_MESSAGE_CREATE`（单聊）、`GROUP_AT_MESSAGE_CREATE`（群 @）；
4. 通过后平台会先发 `op=13` 校验请求，服务会自动应答。

> 频道场景额外需要 WebSocket 常连（官方文档：频道发送消息要求机器人 WS 在线）。
> 本项目只实现 Webhook；若要频道场景，请用官方 SDK 的 WS 传输，在 `bot.on('message')`
> 里调用 `runtime.gateway.handleMessage(runtime.qqAdapter, normalized)`。

## 4. 验证

```powershell
# 用官方事件格式手工打一条（本地调试，服务未启签名校验时）
curl.exe -X POST http://127.0.0.1:8788/qq/webhook `
  -H "Content-Type: application/json" `
  -d '{\"id\":\"evt_1\",\"op\":0,\"t\":\"C2C_MESSAGE_CREATE\",\"d\":{\"id\":\"m1\",\"content\":\"你好\",\"timestamp\":\"2026-01-01T00:00:00Z\",\"author\":{\"user_openid\":\"OPENID\"}}}'
```

真实环境请直接在 QQ 里给机器人发消息 —— 手工伪造会被签名校验拒绝（这是对的）。

## 5. 平台指令

用户可直接发送：

| 指令 | 作用 |
|---|---|
| `/help` | 帮助 |
| `/status` | 关系与记忆概览（只含可公开信息） |
| `/newsession` | 新开会话，长期记忆保留 |
| `/memory` | 查看自己的记忆（最多 12 条） |
| `/forget <id>` / `/forget all confirm` | 删除记忆（软删除，可审计） |
| `/quiet on|off` | 停止/恢复主动联系 |
| `/bind` | 生成一次性绑定码（给酒馆等其他平台用） |
| `/unbind` | 解除当前平台绑定 |

## 6. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 401 bad signature | 签名校验失败（密钥不对 / 时间戳偏移 > 5 分钟） | 检查 AppSecret 与服务器时间 |
| 消息收到但没回复 | 超出被动回复窗口（单聊 60 分钟、群 5 分钟）或次数上限 | 消息已进待发送队列，用户下次来信会并入 |
| 主动消息发不出去 | 用户关闭了「允许主动发送」或账号无额度 | 属平台限制，不要绕过；保持 `QQBOT_PROACTIVE=false` |
| 频道场景报错 | 频道发送要求 WebSocket 在线 | 见 §3 末尾说明 |
| 重复回复同一条 | 平台重复推送同一事件 | 已由去重表拦截；若确有两次回复，检查 `msg_seq` |

## 7. 隐私与安全

- 只存 `openid`（平台侧标识），不存 QQ 号、手机号、头像；
- 私聊内容进入引擎后会按「不可信数据」处理，不会写进人格配置；
- 日志只记事件类型、结果状态、实例 id，不记消息正文（`src/api/server.ts` 的日志策略同源）；
- 删除记忆用 `/forget`，数据库里是软删除（审计可见），不是物理擦除。
