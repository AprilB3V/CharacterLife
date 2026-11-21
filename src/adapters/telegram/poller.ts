/**
 * Telegram 长轮询入口（getUpdates）。
 *
 * 为什么用长轮询而不是 Webhook：本机运行、不需要公网地址和证书。和 OneBot 的 report-server 一样，
 * 服务本体放在 src/ 里可注入、可测，examples/telegram/server.ts 只是读环境变量的薄壳。
 *
 * 处理顺序（每条 Update）：
 *   1. 只接私聊；白名单之外的用户直接忽略（公开机器人谁都能发消息，每条都花模型费用）
 *   2. `/start [绑定码]`、`/link 绑定码` 在这里处理，**不进网关**：
 *      网关会给首次接触的身份自动建实例，先建了实例就绑不到桌面那边已有的角色了
 *   3. 其余消息交给网关；处理期间持续显示「正在输入」
 *
 * offset 不落盘：重启后 Telegram 会重投 24 小时内未确认的 Update，
 * 重复的由网关的 processed_messages 去重。同一私聊的消息串行处理，保证顺序。
 */

import type { RuntimeBundle } from '../../api/runtime-factory.ts'
import type { NormalizedMessage } from '../protocol.ts'
import { TelegramApiError } from './api-client.ts'
import { extractPrivateMessage } from './events.ts'
import type { TelegramAdapter } from './adapter.ts'

export interface TelegramPollerOptions {
  runtime: RuntimeBundle
  /** 允许对话的 Telegram 用户 id（原始数字 id）；null 表示任何人都可以（需显式开启） */
  allowedUserIds: ReadonlySet<string> | null
  /** getUpdates 服务端挂起秒数（默认 30） */
  pollTimeoutSec?: number
  logger?: (line: string) => void
  sleep?: (ms: number) => Promise<void>
  /** 「正在输入」刷新间隔（Telegram 的状态约 5 秒后消失；默认 4500ms） */
  typingRefreshMs?: number
}

export interface TelegramPollerHandle {
  /** 开始轮询；返回的 promise 在 stop() 或致命错误（token 无效）后结束 */
  start(): Promise<void>
  stop(): Promise<void>
  /** 等待已接收消息全部处理完（测试与优雅退出用） */
  waitIdle(timeoutMs?: number): Promise<boolean>
  readonly offset: number | null
}

const BIND_CODE = /^\d{8}$/

const BIND_ERRORS: Record<string, string> = {
  NOT_FOUND: '绑定码不对，检查一下再发一次？',
  EXPIRED: '绑定码过期了，在另一边重新生成一个吧。',
  CONSUMED: '这个绑定码已经用过了，在另一边重新生成一个吧。',
  TOO_MANY_ATTEMPTS: '这个绑定码尝试次数太多，已经失效了，请重新生成。',
  PLATFORM_MISMATCH: '这个绑定码不是给 Telegram 用的。生成时请选择 Telegram。',
}

export function createTelegramPoller(opts: TelegramPollerOptions): TelegramPollerHandle {
  const { runtime } = opts
  const adapter = runtime.telegramAdapter as TelegramAdapter | null
  if (!adapter) throw new Error('运行时没有装配 Telegram 适配器：请先给 assembleRuntime 传 telegram 配置')
  const client = adapter.client
  const pollTimeoutSec = opts.pollTimeoutSec ?? 30
  const logger = opts.logger ?? ((line: string) => console.log(line))
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const typingRefreshMs = opts.typingRefreshMs ?? 4500
  const characterName = runtime.template.profile.name

  let offset: number | null = null
  let stopped = false
  let abort: AbortController | null = null
  const chains = new Map<number, Promise<void>>()
  const inflight = new Set<Promise<void>>()
  const warnedUsers = new Set<string>()

  const log = (payload: Record<string, unknown>): void => {
    logger(JSON.stringify({ t: new Date().toISOString(), ...payload }))
  }

  async function reply(message: NormalizedMessage, text: string): Promise<void> {
    await adapter!.send({
      platform: message.platform,
      identity: message.identity,
      scene: message.scene,
      sceneId: message.sceneId,
      replyTarget: message.replyTarget,
      replyToMessageId: null,
      text,
      proactive: false,
      inboundAt: message.timestamp,
    })
  }

  /** /start 与 /link：返回 true 表示已处理，不再进网关。 */
  async function handleLocalCommand(message: NormalizedMessage): Promise<boolean> {
    const [cmd, arg] = message.text.split(/\s+/, 2)
    const command = (cmd ?? '').toLowerCase()
    if (command !== '/start' && command !== '/link') return false

    const admitted = runtime.gateway.admit(message)
    if (!admitted.ok) return true
    const finish = (): void => {
      runtime.platformStore.updateProcessedStatus(message.platform, message.platformMessageId, 'command')
    }

    const code = (arg ?? '').trim()
    if (command === '/start' && code.length === 0) {
      const known = runtime.identityService.instanceFor(message.platform, message.identity.platformUserId)
      await reply(
        message,
        known
          ? `又见面了。直接发消息就能聊，/help 查看指令。`
          : `你好，我是${characterName}。直接发消息就能聊，/help 查看指令。\n` +
              `如果你已经在别的地方（比如桌面浮窗）和我聊过，想让我记得那些事：在那边生成一个 Telegram 绑定码，` +
              `然后在这里发「/link 绑定码」。请在聊天之前绑定。`,
      )
      finish()
      return true
    }

    if (!BIND_CODE.test(code)) {
      await reply(message, '用法：/link 加 8 位数字绑定码，例如 /link 12345678')
      finish()
      return true
    }

    const existing = runtime.identityService.instanceFor(message.platform, message.identity.platformUserId)
    if (existing) {
      // Check before redeeming: redeeming consumes the code even when the bind is then refused.
      await reply(
        message,
        '这个 Telegram 账号已经有自己的一份记忆了。要换成另一边的角色，先发 /unbind，再发 /link 绑定码。' +
          '（原来的记忆不会删除，只是不再关联到这个账号。）',
      )
      finish()
      return true
    }

    const result = runtime.identityService.redeemBindCode({
      code,
      platform: message.platform,
      platformUserId: message.identity.platformUserId,
      displayName: message.identity.displayName,
    })
    log({ level: 'info', kind: 'bind', ok: result.ok, error: result.error ?? null })
    await reply(
      message,
      result.ok
        ? `绑定好了，是我。之前聊过的事我都记得。`
        : (BIND_ERRORS[result.error ?? ''] ?? `绑定失败（${result.error ?? '未知原因'}）。`),
    )
    finish()
    return true
  }

  async function handleUpdate(message: NormalizedMessage, chatId: number): Promise<void> {
    const started = Date.now()
    if (await handleLocalCommand(message)) return

    const typing = (): void => {
      void client.sendChatAction(chatId, 'typing').catch(() => {})
    }
    typing()
    const timer = setInterval(typing, typingRefreshMs)
    try {
      const outcome = await runtime.gateway.handleMessage(adapter!, message)
      // Log outcome only, never message text
      log({
        level: 'info',
        kind: 'message',
        status: outcome.status,
        instance: outcome.instanceId ?? null,
        reason: outcome.reason ?? null,
        ms: Date.now() - started,
      })
    } finally {
      clearInterval(timer)
    }
  }

  function dispatch(raw: unknown): void {
    let extracted: ReturnType<typeof extractPrivateMessage>
    let message: NormalizedMessage | null
    try {
      extracted = extractPrivateMessage(raw)
      if (!extracted) return
      const userKey = String(extracted.userId)
      if (opts.allowedUserIds && !opts.allowedUserIds.has(userKey)) {
        if (!warnedUsers.has(userKey)) {
          warnedUsers.add(userKey)
          // The raw id is printed once so the owner can copy it into TELEGRAM_ALLOWED_USER_IDS.
          log({ level: 'warn', msg: '忽略白名单之外的用户', telegramUserId: userKey })
        }
        return
      }
      message = adapter!.parseInbound(raw)
      if (!message) return
    } catch (err) {
      log({ level: 'warn', msg: 'Update 解析失败', error: (err as Error).message })
      return
    }

    const chatId = extracted.chatId
    const previous = chains.get(chatId) ?? Promise.resolve()
    const next = previous
      .then(() => handleUpdate(message!, chatId))
      .catch((err: unknown) => {
        log({ level: 'error', msg: '消息处理失败', error: (err as Error).message })
      })
    chains.set(chatId, next)
    inflight.add(next)
    void next.finally(() => {
      inflight.delete(next)
      if (chains.get(chatId) === next) chains.delete(chatId)
    })
  }

  async function loop(): Promise<void> {
    let backoffMs = 1000
    while (!stopped) {
      abort = new AbortController()
      try {
        const updates = await client.getUpdates({ offset, timeoutSec: pollTimeoutSec, signal: abort.signal })
        backoffMs = 1000
        for (const update of updates) {
          const id = (update as { update_id?: number }).update_id
          if (typeof id === 'number') offset = Math.max(offset ?? 0, id + 1)
          dispatch(update)
        }
      } catch (err) {
        if (stopped) break
        if (err instanceof TelegramApiError && err.status === 401) {
          log({ level: 'error', msg: 'bot token 无效（401），停止轮询' })
          stopped = true
          break
        }
        if (err instanceof TelegramApiError && err.status === 409) {
          log({ level: 'error', msg: '409 冲突：这个 bot 设置了 Webhook，或另一个进程正在轮询。请先停掉另一个进程' })
        } else {
          log({ level: 'warn', msg: '轮询失败，稍后重试', error: (err as Error).message, retryInMs: backoffMs })
        }
        const wait = err instanceof TelegramApiError && err.retryAfterSec ? err.retryAfterSec * 1000 : backoffMs
        await sleep(wait)
        backoffMs = Math.min(backoffMs * 2, 30_000)
      } finally {
        abort = null
      }
    }
  }

  let running: Promise<void> | null = null

  const handle: TelegramPollerHandle = {
    get offset() {
      return offset
    },
    start() {
      if (!running) {
        stopped = false
        running = loop()
      }
      return running
    },
    async waitIdle(timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs
      while (inflight.size > 0) {
        if (Date.now() > deadline) return false
        await Promise.race([Promise.allSettled([...inflight]), new Promise((resolve) => setTimeout(resolve, 50))])
      }
      return true
    },
    async stop() {
      stopped = true
      abort?.abort()
      if (running) await running
      running = null
      await handle.waitIdle()
    },
  }
  return handle
}
