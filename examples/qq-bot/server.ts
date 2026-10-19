/**
 * QQ 官方机器人 Webhook 服务（真实接入入口）
 *
 * 只实现官方文档支持的 Webhook 传输；WebSocket 长连接需要官方 SDK
 * （`@tencent-connect/qqbot-nodejs`）—— 本项目坚持零运行时依赖，因此不打包 SDK，
 * 需要长连接时请在 SDK 的 message 回调里调用 `deliverNormalized()`（见 docs/QQ_SETUP.md）。
 *
 * 环境变量：
 *   QQBOT_APP_ID / QQBOT_APP_SECRET   官方凭证（必需）
 *   QQBOT_WEBHOOK_PORT                监听端口（默认 8788）
 *   QQBOT_WEBHOOK_PATH                回调路径（默认 /qq/webhook）
 *   QQBOT_PROACTIVE                   是否声明主动消息能力（默认 false）
 *   CHARACTERLIFE_DB                  数据库路径
 *   DEEPSEEK_API_KEY                  可选：不填则用 MockProvider
 *
 * 运行：
 *   node examples/qq-bot/server.ts
 *   # 然后在开放平台把回调地址填成 https://<你的域名>/qq/webhook（需要公网/内网穿透 + IP 白名单）
 */

import { createServer } from 'node:http'
import { loadEnvConfig, assembleRuntime } from '../../src/api/runtime-factory.ts'
import { isUrlVerificationEvent, signWebhookChallenge, verifyQQWebhookSignature } from '../../src/adapters/qq/webhook.ts'

const env = loadEnvConfig()
if (!env.qq) {
  console.error('❌ 缺少 QQBOT_APP_ID / QQBOT_APP_SECRET，无法启动真实 QQ Webhook 服务')
  console.error('   离线体验请运行：node examples/qq-bot/demo.ts')
  process.exit(2)
}

const port = Number(process.env.QQBOT_WEBHOOK_PORT ?? 8788)
const path = process.env.QQBOT_WEBHOOK_PATH ?? '/qq/webhook'
const verifySignature = process.env.QQBOT_SKIP_SIGNATURE !== 'true'

const runtime = assembleRuntime({
  dbPath: env.dbPath,
  worldId: process.env.CHARACTERLIFE_WORLD ?? 'world_qq',
  qq: { appId: env.qq.appId, appSecret: env.qq.appSecret, proactive: env.qq.proactive },
})

const server = createServer((req, res) => {
  void (async () => {
    const url = (req.url ?? '/').split('?')[0]
    if (req.method !== 'POST' || url !== path) {
      res.writeHead(404).end('not found')
      return
    }

    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const rawBody = Buffer.concat(chunks).toString('utf8')

    let payload: unknown
    try {
      payload = JSON.parse(rawBody)
    } catch {
      res.writeHead(400).end('bad json')
      return
    }

    // 1) 回调地址校验（op = 13）
    if (isUrlVerificationEvent(payload)) {
      const signed = signWebhookChallenge({
        appSecret: env.qq!.appSecret,
        plainToken: payload.d.plain_token,
        eventTs: String(payload.d.event_ts),
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(signed))
      return
    }

    // 2) 普通事件：验签（失败一律拒绝，不失败放行）
    if (verifySignature) {
      const result = verifyQQWebhookSignature({
        appSecret: env.qq!.appSecret,
        rawBody,
        signatureHex: req.headers['x-signature-ed25519'] as string | undefined,
        timestamp: req.headers['x-signature-timestamp'] as string | undefined,
      })
      if (!result.ok) {
        console.warn(`[qq] 签名校验失败：${result.reason}`)
        res.writeHead(401).end('bad signature')
        return
      }
    }

    // 3) 交给 Gateway（去重 / 身份 / 引擎 / 发送）
    try {
      const outcome = await runtime.gateway.handleRaw('qq', payload)
      console.log(`[qq] ${outcome.status} instance=${outcome.instanceId ?? '-'} ${outcome.reason ?? ''}`)
    } catch (err) {
      console.error(`[qq] 处理失败：${(err as Error).message}`)
    }
    // 平台只要求尽快 200；重复投递由去重表兜底
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"op":12}')
  })()
})

server.listen(port, '127.0.0.1', () => {
  console.log(`QQ Webhook 监听 http://127.0.0.1:${port}${path}`)
  console.log(`数据库：${env.dbPath}`)
  console.log('注意：腾讯要求回调地址可公网访问且配置 IP 白名单；本项目不代为部署。')
})

process.on('SIGINT', () => {
  server.close()
  runtime.close()
  process.exit(0)
})
