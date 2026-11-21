/**
 * Telegram 机器人入口（只跑 Telegram，不开 HTTP API）。
 *
 * 要和桌面浮窗 / SillyTavern 共用同一个角色，请改用 examples/sillytavern/start-server.ts：
 * 设置了 TELEGRAM_BOT_TOKEN 时它会在同一个进程里同时启动 Telegram 轮询。
 * 不要让两个进程打开同一个数据库。
 *
 * 环境变量（见 .env.example 的 Telegram 一节）：
 *   TELEGRAM_BOT_TOKEN          必填，找 @BotFather 申请
 *   TELEGRAM_ALLOWED_USER_IDS   允许对话的用户 id（逗号分隔）
 *   TELEGRAM_API_BASE           可选，自建反代地址
 *   CHARACTERLIFE_DB / CHARACTERLIFE_WORLD / DEEPSEEK_API_KEY 同其他入口
 *
 * 运行：
 *   node examples/telegram/server.ts
 */

import { loadEnvConfig, assembleRuntime } from '../../src/api/runtime-factory.ts'
import { bootTelegram } from './boot.ts'
import { bootConsole } from '../console-boot.ts'

const env = loadEnvConfig()
if (!env.telegram) {
  console.error('❌ 缺少 TELEGRAM_BOT_TOKEN，无法启动 Telegram 机器人')
  process.exit(2)
}

const runtime = assembleRuntime({
  dbPath: env.dbPath,
  worldId: process.env.CHARACTERLIFE_WORLD ?? 'world_local',
  auditFile: null,
  telegram: {
    token: env.telegram.token,
    apiBase: env.telegram.apiBase,
    proactive: env.telegram.proactive,
    parse: env.telegram.parse,
    splitParagraphs: env.telegram.splitParagraphs,
  },
})

const poller = await bootTelegram(runtime, env.telegram)
if (!poller) {
  runtime.close()
  process.exit(1)
}
console.log(`数据库：${env.dbPath}`)
const ownerConsole = await bootConsole(runtime)

const shutdown = async (): Promise<void> => {
  console.log('\n正在等待在途消息处理完…')
  await Promise.allSettled([poller.stop(), ownerConsole?.close()])
  runtime.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown())
process.on('SIGTERM', () => void shutdown())
