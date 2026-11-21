/**
 * Start the Telegram poller on an already assembled runtime.
 *
 * Shared by examples/telegram/server.ts (Telegram only) and examples/sillytavern/start-server.ts
 * (API server + Telegram in one process). One process per database: the kernel serializes
 * each instance with an in-process lock, so two processes on the same SQLite file would race.
 */

import type { EnvConfig, RuntimeBundle } from '../../src/api/runtime-factory.ts'
import { createTelegramPoller } from '../../src/adapters/telegram/poller.ts'
import type { TelegramPollerHandle } from '../../src/adapters/telegram/poller.ts'

export async function bootTelegram(
  runtime: RuntimeBundle,
  cfg: NonNullable<EnvConfig['telegram']>,
): Promise<TelegramPollerHandle | null> {
  const adapter = runtime.telegramAdapter
  if (!adapter) return null

  if (cfg.allowedUserIds && cfg.allowedUserIds.size === 0) {
    console.warn('⚠ TELEGRAM_ALLOWED_USER_IDS 为空：所有人的消息都会被忽略。')
    console.warn('  先给机器人发一条消息，日志会打印你的 Telegram 用户 id，填进白名单后重启。')
  }

  let username: string | null = null
  try {
    const me = await adapter.client.getMe()
    username = me.username ?? null
  } catch (err) {
    console.error(`❌ Telegram getMe 失败：${(err as Error).message}`)
    console.error('   检查 TELEGRAM_BOT_TOKEN；国内网络需要 TELEGRAM_API_BASE 反代或 NODE_USE_ENV_PROXY=1 + HTTPS_PROXY')
    return null
  }

  const poller = createTelegramPoller({ runtime, allowedUserIds: cfg.allowedUserIds })
  void poller.start()
  console.log(`Telegram 机器人 @${username ?? '?'} 已开始长轮询（仅私聊）`)
  console.log(
    `  白名单：${cfg.allowedUserIds ? `${cfg.allowedUserIds.size} 个用户` : '⚠ 任何人（TELEGRAM_ALLOW_ANYONE=true）'}` +
      `；用户 id ${cfg.parse.anonymizeUserIds === false ? '⚠ 明文落库' : '哈希为假名后落库'}`,
  )
  if (username) {
    console.log('  绑定桌面角色：POST /v1/identity/bind-code {"targetPlatform":"telegram"} 拿到 8 位码，')
    console.log(`  然后打开 https://t.me/${username}?start=<绑定码>，或在机器人里发 /link <绑定码>`)
  }
  return poller
}
