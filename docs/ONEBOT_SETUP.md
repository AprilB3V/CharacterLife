# OneBot 11 接入步骤（用你自己的 QQ 号）

> 本文只写「怎么把一个 OneBot 网关接到 CharacterLife」。
> 适配器实现见 `src/adapters/onebot/`，能力与未验证项见文末 §8。

## 0. 先搞清楚你走的是哪条路

| | QQ 官方机器人 | OneBot 网关（本文） |
|---|---|---|
| 入口 | 开放平台的应用机器人 | 你自己的 QQ 号（网关模拟登录） |
| 群里能不能看到 | 只有 @ 它才行 | 能收到全部群消息（但本项目默认只回 @） |
| 回复限制 | 单聊 60 分钟 4 条 / 群 5 分钟 5 条 | 无平台窗口，只有网关自身频控 |
| 主动消息 | 需要额度 + 用户开关 | 能发就发 |
| 协议合法性 | 官方授权 | **非官方协议**，有账号风险，见 §7 |
| 本项目实现 | `src/adapters/qq/` | `src/adapters/onebot/` |

两条路可以同时挂在一个角色实例上（`platform_identities` 表），人格/记忆共享、会话各自独立。

## 1. 前置条件

| 项 | 说明 |
|---|---|
| Node.js | ≥ 22.6（与项目其他入口一致） |
| 一个 QQ 号 | 建议**小号**，不要用主号跑非官方协议 |
| 一个 OneBot 11 网关 | NapCat / Lagrange.OneBot / SnowLuma 任选 |
| 网关的两种传输 | **HTTP API**（本项目发消息用）+ **HTTP 上报**（网关推事件给我们） |

本项目**只实现 HTTP 上报 + HTTP API**，不实现 WebSocket（Node 无内置 WS 客户端，引 SDK 会
破坏「零运行时依赖」这条前提）。所以网关侧只开 HTTP，不要开反向 WS。

## 2. 网关侧配置

### 2.1 通用要求

| 项 | 值 |
|---|---|
| HTTP API 地址 | `http://127.0.0.1:3000`（端口自选，和 `ONEBOT_API_BASE` 一致） |
| access_token | 随便一个长随机串，和 `ONEBOT_ACCESS_TOKEN` 一致 |
| HTTP 上报地址 | `http://127.0.0.1:8790/onebot/event`（与 `ONEBOT_PORT` / `ONEBOT_PATH` 一致） |
| 上报 secret | 与 `ONEBOT_SECRET` 一致（**强烈建议配置**，否则本机任何进程都能伪造消息） |
| 上报格式 | `array`（推荐）或 `string`（CQ 码）—— 两种本项目都能解析 |

### 2.2 NapCat

1. 启动 NapCat → WebUI → 网络配置；
2. 添加 **HTTP 服务器**：端口 `3000`，token 填随机串；
3. 添加 **HTTP 客户端**：URL `http://127.0.0.1:8790`，后缀 `/onebot/event`，secret 填随机串；
   上报数据类型选 `array`；
4. 不要启用「WebSocket 服务器 / 反向 WS」，本项目不连。

> 各版本菜单名略有差异，认准「HTTP 服务器（正向）」+「HTTP 客户端（上报）」这两项即可。

### 2.3 Lagrange.OneBot

`appsettings.json`：

```json
{
  "Implementations": [
    { "Type": "HttpServer", "Host": "127.0.0.1", "Port": 3000, "AccessToken": "<随机串>" },
    { "Type": "HttpPost", "Host": "127.0.0.1", "Port": 8790, "Suffix": "/onebot/event", "Secret": "<随机串>", "HeartBeatInterval": 5000 }
  ]
}
```

### 2.4 SnowLuma

按它自己的文档配「HTTP API + HTTP 上报」两项。**本项目没有在 SnowLuma 上验证过**
（开发环境里网关不可达），配好后请以 §4 的验证步骤为准。

## 3. 本项目侧启动

### 3.1 推荐：用启动脚本（会读 .env + 先体检再启动）

```powershell
cd C:\Git\CharacterLife\CharacterLife

# 1) 把配置写进 .env（复制模板即可；只有这个脚本会读 .env）
Copy-Item .env.example .env
notepad .env        # 至少填 ONEBOT_API_BASE，建议同时填 ACCESS_TOKEN / SECRET

# 2) 先体检：不启动服务，只检查 Node 版本 / node:sqlite / 配置 / 端口 / 网关连通性
.\scripts\start-onebot.cmd -Probe

# 3) 体检通过后启动（Ctrl+C 停止）
.\scripts\start-onebot.cmd
```

脚本做的事：读 `.env` → 体检 → 打印「该往网关里填什么」→ 前台启动服务。
体检不通过时**不会硬启动**，而是直接告诉你缺什么、怎么补，退出码 `2`。

也可以用 npm 别名（等价于第 3 步）：

```powershell
npm run onebot:start              # 直连启动
npm run onebot:start -- -Probe    # 透传参数
```

**常用参数**

| 参数 | 作用 |
|---|---|
| `-Probe` | 只体检不启动（排查配置用） |
| `-ApiBase` / `-AccessToken` / `-Secret` / `-Port` / `-Path` | 临时覆盖 .env（优先级最高） |
| `-Database` / `-World` | 覆盖 `CHARACTERLIFE_DB` / `CHARACTERLIFE_WORLD`（注意是 `-Database`，不是 `-Db`：后者与内置 `-Debug` 的别名冲突） |
| `-EnvFile <路径>` | 用别的 env 文件 |
| `-NoEnvFile` | 完全不读 .env |
| `-Force` | 让 .env 覆盖已存在的进程环境变量（默认不覆盖） |
| `-SkipGatewayProbe` | 跳过网关连通性探测（网关还没起时用） |
| `-GatewayExe <exe>` `-GatewayArgs "a,b"` | 顺手把网关也拉起来（网关参数用逗号分隔；**路径请用绝对路径**，相对路径是相对网关自身目录解析的） |
| `-KeepGateway` | 退出时保留网关进程（默认关掉由脚本拉起的网关） |

脚本**只接管四类前缀**：`ONEBOT_` / `CHARACTERLIFE_` / `DEEPSEEK_` / `QQBOT_`。
`.env` 里其他行（例如误写的 `NODE_OPTIONS=...`）会被跳过并计入「跳过 N 行」，避免一行笔误改坏运行环境。

> 两个 Windows 细节，脚本已经处理，但你手工改脚本时需要知道：
> 1. `start-onebot.ps1` 是 **UTF-8 with BOM**：Windows PowerShell 5.1 对没有 BOM 的脚本会按本地代码页解码，中文全变乱码。
>    用会剥掉 BOM 的编辑器/工具改完这个文件后，请自行补回 BOM。
> 2. 本机可能只有 Windows PowerShell 5.1（没有 `pwsh` 7）：脚本按 5.1 兼容写的，`start-onebot.cmd` 用 `-ExecutionPolicy Bypass` 调用，避免执行策略挡路。

### 3.2 不用脚本（自己注入环境变量）

```powershell
cd C:\Git\CharacterLife\CharacterLife

$env:ONEBOT_API_BASE     = "http://127.0.0.1:3000"   # 网关 HTTP API
$env:ONEBOT_ACCESS_TOKEN = "<与网关一致的 token>"
$env:ONEBOT_SECRET       = "<与网关一致的 secret>"
$env:ONEBOT_PORT         = "8790"
$env:ONEBOT_PATH         = "/onebot/event"

$env:CHARACTERLIFE_DB    = "data/characterlife.db"
$env:CHARACTERLIFE_WORLD = "world_onebot"
$env:DEEPSEEK_API_KEY    = "sk-..."                  # 不填则用 MockProvider（固定台词）

npm run onebot:server
```

输出：

```
OneBot 上报监听 http://127.0.0.1:8790/onebot/event
网关 API：http://127.0.0.1:3000（已配置 access_token）
群聊策略：仅被 @ 或 /指令时回应
隐私：QQ 号哈希为假名后落库
上报签名：已启用
```

### 3.3 两种不需要真网关的自检

```powershell
# A) 离线全链路（MockTransport，零网络、零配置）
npm run onebot:demo

# B) 起一个「假网关」，验证 配置 → 上报 → 引擎 → 发送 这条真实 HTTP 链路
node scripts/fake-onebot-gateway.mjs 3999          # 窗口 1：假网关，会打印每次调用
.\scripts\start-onebot.cmd -ApiBase http://127.0.0.1:3999   # 窗口 2：本服务
# 然后按 §4 发一条消息，假网关窗口会打印 send_private_msg 的完整内容
```

B 的价值：**先把「本服务 + HTTP 链路」证明是好的，再去怀疑网关或 QQ 账号**。
`scripts/fake-onebot-gateway.mjs` 是测试替身，不连 QQ、不处理登录，别当生产网关用。

## 4. 验证

```powershell
# 1) 服务自己在听，且知道网关在哪（不泄露 token）
curl.exe http://127.0.0.1:8790/healthz

# 2) 私聊机器人发一句「你好」，控制台应出现：
#    {"kind":"message/private","status":"replied","instance":"inst_001",...}

# 3) 群里 @ 它 —— 会回；不 @ 只是它在看，不会插嘴
# 4) 群里发 /help —— 不需要 @ 也会回（否则没人知道有哪些指令）
```

日志只有 `kind / status / instance / reason / ms`，**不记消息正文**。

> 手工造一条事件时，**不要用 PowerShell 的 `Invoke-WebRequest -Body <中文>`**：
> PS 会按自己的编码重写字符串 Body，导致 HMAC 签不中（表现为 `401 BAD_SIGNATURE`），
> 这不是服务的问题。用 `curl`、Node 或 `scripts/fake-onebot-gateway.mjs` 那条路验证。

### 4.1 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| `/healthz` 通，但私聊没回复 | 网关 API 连不上 / token 不对 | 看日志 `reason=NO_PERMISSION` 或 `PLATFORM_ERROR`；先用 `curl -X POST http://127.0.0.1:3000/get_login_info -H "Authorization: Bearer <token>"` 手测网关 |
| 上报返回 401 `MISSING_HEADER` | 本服务配了 `ONEBOT_SECRET`，网关没配 secret | 两边要么都配，要么都不配（都不配会打警告） |
| 上报返回 401 `BAD_SIGNATURE` | secret 不一致；或**用 PowerShell 手工发中文 Body** | 对齐 secret。PS 会按自己的编码重写字符串 Body，导致签不中——这不是服务的问题，用 `curl`/Node 发，或先用 ASCII 验证 |
| 群里 @ 了它却不回 | 上报里没有 `at` 段（部分网关只给 `raw_message`） | 事件里补 `self_id` 或用 `ONEBOT_SELF_ID`；仍不行就临时 `ONEBOT_GROUP_MENTION_ONLY=false` 验证链路，确认后再关掉 |
| 群里每句都回 | `ONEBOT_GROUP_MENTION_ONLY=false` | 改回 `true`（否则刷屏 + 风控） |
| 日志 `status=duplicate` 但没有回复 | 网关重投了同一条消息，去重表拦住了 | 正常。若确实需要重答，改 `message_id` 或清 `processed_messages` 对应行 |
| 日志 `status=delivery_failed` | 网关拒收（风控 / 群被禁言 / token 失效） | 看 `reason`：`NO_PERMISSION` 查 token，`PLATFORM_ERROR` 查网关日志与群状态 |
| 重启后同一个人变成新实例 | 换了 `ONEBOT_ANONYMIZE` 开关，或换了 `CHARACTERLIFE_DB` / `CHARACTERLIFE_WORLD` | 假名只依赖 QQ 号，同一份库/世界线里不会变；确认上面三个值没动过 |
| 脚本报「缺少 ONEBOT_API_BASE」 | 没配 `.env` 也没传参 | 建 `.env`、传 `-ApiBase`、或临时 `$env:ONEBOT_API_BASE=...`（脚本会把三种写法都印出来） |
| 脚本报「端口 8799 已被占用」 | 已经有一个实例在跑 | 关掉旧实例，或 `-Port 8791`；查占用：`netstat -ano \| findstr :8799` |
| 脚本报「非回环地址…拒绝启动」 | `ONEBOT_HOST` 不是 127.0.0.1 但没开 `ONEBOT_ALLOW_PUBLIC` | 本机用就改回 `127.0.0.1`；跨机才开 `ONEBOT_ALLOW_PUBLIC=true` 并配防火墙 |
| 脚本报「网关进程已退出」 | `-GatewayArgs` 里用了相对路径（相对网关自身目录解析） | 改成绝对路径；或网关自身启动失败，单独跑一次看它的报错 |
| 脚本输出中文乱码 | 用剥掉 BOM 的编辑器改过 `.ps1` | 重新保存为 **UTF-8 with BOM**（Windows PowerShell 5.1 的硬性要求） |
| `.env` 里的值没生效 | 该变量在进程里已存在（默认不覆盖）；或前缀不在白名单 | 加 `-Force` 让它覆盖；确认变量名以 `ONEBOT_`/`CHARACTERLIFE_`/`DEEPSEEK_`/`QQBOT_` 开头 |

## 5. 群聊策略（默认值就是安全值）

| 环境变量 | 默认 | 作用 |
|---|---|---|
| `ONEBOT_GROUP_MENTION_ONLY` | `true` | 群里只有被 @ 才回应。设 `false` = 每条群消息都回，等于刷屏 + 求风控 |
| `ONEBOT_ALLOW_GROUP_COMMANDS` | `true` | 群里的 `/<指令>` 无需 @ 也能触发 |

两者都在 `src/adapters/onebot/events.ts` 的解析层实现，**不是**在提示词里「让它少说话」——
也就是说不合规的群消息根本不会进入引擎、不会写记忆、不会花 token。

## 6. 隐私

OneBot 给的 `user_id` 是**真实 QQ 号**。本项目的默认处理：

| 项 | 默认 | 说明 |
|---|---|---|
| `ONEBOT_ANONYMIZE` | `true` | 落库前把 QQ 号哈希成 `qq_<16hex>`。确定性哈希（无盐），所以同一个人跨群/私聊/重启都是同一个假名，不会人格割裂 |
| `ONEBOT_CAPTURE_NICKNAME` | `false` | 不采集昵称/群名片。引擎的身份判定本来就不依赖展示名 |
| 发送目标 | — | 回复时用 `replyTarget` 里的原始 QQ 号/群号发给网关，**这个值不进数据库** |

诚实说明：假名可以被穷举（QQ 号空间不大），它的作用是「数据库里不出现 QQ 号」，
不是密码学匿名。要更强的隔离，请给每个用户单独部署实例。

## 7. 风险与限制

1. **账号风险**：OneBot 是社区协议，不是腾讯官方授权方式。用它跑机器人可能违反 QQ 用户
   协议，存在被风控/封号的可能。**用你自己的号、你自己承担**，本项目不提供任何绕过手段。
2. **登录态**：网关掉线要重新扫码/密码登录，本项目不管理网关生命周期。
3. **只支持文本**：图片/语音/视频会转成 `[图片]` `[语音]` 这类占位符进引擎，不下载、不处理。
4. **不引用回复**：`replyToMessageId` 目前不用于引用气泡（避免多一层协议分歧）。
5. **单进程**：与项目其他部分一致，进程内锁 + SQLite 单写者，不支持多实例横向扩展。
6. **消息体量**：网关上报是「先 204 再处理」，处理失败只记日志、不回滚去重记录——
   也就是说一条消息如果模型调用炸了，它不会自动重试（网关也不会重投成功记录）。

## 8. 已验证 / 未验证（不要混为一谈）

已验证（离线，可复现）：

- 事件解析：私聊 / 群聊 / CQ 码字符串 / 图片语音占位 / @ 与 @全体 / 机器人自回声 / meta_event；
- 群聊 @ 过滤与 `/指令` 例外；
- 端到端：解析 → 去重 → 身份（假名）→ 引擎 → `send_private_msg` / `send_group_msg`；
- 上报服务：真端口、真 HMAC-SHA1 验签、204 先应答、401 拒绝、404/405/400、重投去重；
- 失败降级：retcode 失败 / HTTP 401 / 场景不一致 / 空文本 / 超长截断；
- 主动消息能力开关；人格不可被聊天覆盖。

**未验证**：

- 没有在真实 NapCat / Lagrange.OneBot / SnowLuma 上跑过（本环境网关不可达，无 QQ 小号）；
- 没有在真实 QQ 群/私聊里收发过（协议行为按 OneBot 11 规范实现）；
- 不同网关上报字段的差异（例如部分实现缺 `self_id`、`sender.card` 位置不同）未逐一核对。

结论：**协议完整 + 离线可复现 + 真实网关联调未执行**。第一次接真网关时，请先按 §4 验证
`/healthz` 与一条私聊，再开放群聊。
