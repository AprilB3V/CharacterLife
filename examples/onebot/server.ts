/**
 * OneBot 11 接入入口（HTTP 上报 + HTTP API 两条通道）。
 *
 * 拓扑：
 *
 *   QQ 客户端
 *     ↓ 消息
 *   网关程序（NapCat / Lagrange.OneBot / SnowLuma）── HTTP 上报 ──▶ 本服务 :8790/onebot/event
 *     ↑                                                                    │
 *     └────────────── HTTP API（send_private_msg / send_group_msg）◀──────┘
 *
 * 环境变量（全部可选，见 .env.example）：
 *   ONEBOT_API_BASE            网关 HTTP API 地址（必需），例如 http://127.0.0.1:3000
 *   ONEBOT_ACCESS_TOKEN        网关 access_token（与网关配置一致）
 *   ONEBOT_SECRET              上报签名密钥（与网关的 secret 一致，强烈建议配置）
 *   ONEBOT_HOST / ONEBOT_PORT  本服务监听地址/端口（默认 127.0.0.1:8790）
 *   ONEBOT_PATH                上报路径（默认 /onebot/event）
 *   ONEBOT_ALLOW_PUBLIC        允许非回环监听（默认 false；跨机部署才需要）
 *   ONEBOT_GROUP_MENTION_ONLY  群聊只在被 @ 时回应（默认 true）
 *   ONEBOT_ALLOW_GROUP_COMMANDS 群聊里 /help 这类指令无需 @（默认 true）
 *   ONEBOT_ANONYMIZE           把 QQ 号哈希成假名再落库（默认 true）
 *   ONEBOT_CAPTURE_NICKNAME    是否把昵称带进 displayName（默认 false）
 *   ONEBOT_SELF_ID             机器人 QQ 号（事件缺 self_id 时用于判断「被 @」）
 *   ONEBOT_PROACTIVE           是否声明主动消息能力（默认 true）
 *   CHARACTERLIFE_DB / CHARACTERLIFE_WORLD / DEEPSEEK_API_KEY 同其他入口
 *
 * 运行：
 *   node examples/onebot/server.ts
 *   # 然后在网关里把「HTTP 上报地址」填成 http://127.0.0.1:8790/onebot/event，
 *   # secret 与本服务的 ONEBOT_SECRET 保持一致。
 */

import { loadEnvConfig, assembleRuntime } from '../../src/api/runtime-factory.ts'
import { createOneBotReportServer } from '../../src/adapters/onebot/report-server.ts'

const env = loadEnvConfig()
if (!env.onebot) {
  console.error('❌ 缺少 ONEBOT_API_BASE（网关 HTTP API 地址），无法启动 OneBot 服务')
  console.error('   离线体验请运行：node examples/onebot/demo.ts')
  console.error('   示例：$env:ONEBOT_API_BASE = "http://127.0.0.1:3000"')
  process.exit(2)
}

const cfg = env.onebot
const runtime = assembleRuntime({
  dbPath: env.dbPath,
  worldId: process.env.CHARACTERLIFE_WORLD ?? 'world_onebot',
  onebot: {
    baseUrl: cfg.baseUrl,
    accessToken: cfg.accessToken,
    proactive: cfg.proactive,
    parse: cfg.parse,
  },
})

const handle = createOneBotReportServer({
  runtime,
  secret: cfg.secret,
  path: cfg.path,
  host: cfg.host,
  port: cfg.port,
  allowNonLoopback: cfg.allowNonLoopback,
})

const { url } = await handle.listen()
console.log(`OneBot 上报监听 ${url}${cfg.path}`)
console.log(`网关 API：${runtime.onebotAdapter!.describe()}`)
console.log(`数据库：${env.dbPath}`)
console.log(`群聊策略：${cfg.parse.groupMentionOnly === false ? '每条消息都回应（慎用）' : '仅被 @ 或 /指令时回应'}`)
console.log(`隐私：${cfg.parse.anonymizeUserIds === false ? '⚠ 直接存 QQ 号' : 'QQ 号哈希为假名后落库'}`)
console.log(`上报签名：${cfg.secret ? '已启用' : '⚠ 未配置 secret（任何本机进程都能伪造消息）'}`)

const shutdown = async (): Promise<void> => {
  console.log('\n正在等待在途事件处理完…')
  await handle.close()
  runtime.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
