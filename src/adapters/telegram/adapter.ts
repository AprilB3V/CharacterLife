/**
 * Telegram 机器人适配器（Bot API，私聊）。
 *
 * 职责边界与其他适配器一致：只做协议转换 + 发送，不判定身份、不写库、不改人格。
 *
 * 平台能力（核查日期 2026-11-18，https://core.telegram.org/bots/api 与 bots/faq）：
 * - 主动消息：用户对机器人按过 Start 之后，机器人可以随时给这个私聊发消息；
 *   用户屏蔽机器人后返回 403，这里映射为 NO_PERMISSION。
 * - 无被动回复窗口、无每条消息回复次数限制。
 * - 频率：同一私聊建议不超过每秒 1 条；超限返回 429 + retry_after。
 * - 单条文本上限 4096 字符。
 *
 * 陪伴感相关的发送细节：
 * - 回复按空行拆成至多 maxBubbles 条气泡，像真人分几条发；
 * - 气泡之间先显示「正在输入」，停顿时长按下一条的字数估算（有上限，可关闭）。
 */

import type {
  MessageDeliveryResult,
  NormalizedMessage,
  OutboundMessage,
  PlatformAdapter,
  PlatformCapabilities,
} from '../protocol.ts'
import type { TelegramApiClient, TelegramTransportResponse } from './api-client.ts'
import type { TelegramParseOptions } from './events.ts'
import { TELEGRAM_PLATFORM, decodeReplyTarget, parseTelegramUpdate } from './events.ts'

export const TELEGRAM_MAX_TEXT = 4096

export interface TelegramAdapterOptions {
  client: TelegramApiClient
  capabilities?: Partial<PlatformCapabilities>
  parse?: TelegramParseOptions
  /** 按空行拆成多条气泡（默认 true） */
  splitParagraphs?: boolean
  /** 最多拆成几条，超出部分并入最后一条（默认 3） */
  maxBubbles?: number
  /** 气泡间「正在输入」的停顿：每字毫秒数与上限（默认 40ms/字，最多 2500ms；设 0 关闭） */
  typingMsPerChar?: number
  typingMaxMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_CAPABILITIES: PlatformCapabilities = {
  proactive: true,
  replyWindowMs: 0,
  maxRepliesPerMessage: 0,
  streaming: false,
  webhookSignature: false,
}

/** 把回复拆成气泡；每条都保证不超过 Telegram 单条上限。 */
export function splitIntoBubbles(text: string, opts: { splitParagraphs: boolean; maxBubbles: number }): string[] {
  const trimmed = text.trim()
  if (trimmed.length === 0) return []
  let parts = opts.splitParagraphs
    ? trimmed
        .split(/\n\s*\n/)
        .map((p) => p.trim())
        .filter((p) => p.length > 0)
    : [trimmed]
  const max = Math.max(1, opts.maxBubbles)
  if (parts.length > max) {
    parts = [...parts.slice(0, max - 1), parts.slice(max - 1).join('\n\n')]
  }
  const out: string[] = []
  for (const part of parts) {
    for (let i = 0; i < part.length; i += TELEGRAM_MAX_TEXT) out.push(part.slice(i, i + TELEGRAM_MAX_TEXT))
  }
  return out
}

export class TelegramAdapter implements PlatformAdapter {
  readonly platform = TELEGRAM_PLATFORM
  readonly capabilities: PlatformCapabilities
  readonly client: TelegramApiClient
  #parse: TelegramParseOptions
  #splitParagraphs: boolean
  #maxBubbles: number
  #typingMsPerChar: number
  #typingMaxMs: number
  #now: () => number
  #sleep: (ms: number) => Promise<void>
  /** 最近一次发送结果，便于测试与审计 */
  lastResult: MessageDeliveryResult | null = null

  constructor(opts: TelegramAdapterOptions) {
    this.client = opts.client
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...(opts.capabilities ?? {}) }
    this.#parse = opts.parse ?? {}
    this.#splitParagraphs = opts.splitParagraphs !== false
    this.#maxBubbles = opts.maxBubbles ?? 3
    this.#typingMsPerChar = opts.typingMsPerChar ?? 40
    this.#typingMaxMs = opts.typingMaxMs ?? 2500
    this.#now = opts.now ?? Date.now
    this.#sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  }

  parseInbound(raw: unknown): NormalizedMessage | null {
    return parseTelegramUpdate(raw, this.#parse)
  }

  async send(message: OutboundMessage): Promise<MessageDeliveryResult> {
    const started = this.#now()
    const finish = (partial: Omit<MessageDeliveryResult, 'latencyMs'>): MessageDeliveryResult => {
      const result = { ...partial, latencyMs: this.#now() - started }
      this.lastResult = result
      return result
    }

    if (message.proactive && !this.capabilities.proactive) {
      return finish({
        ok: false,
        platformMessageId: null,
        queued: true,
        error: { code: 'NOT_SUPPORTED', message: 'Telegram 主动消息已在配置中关闭，消息保留在待发送队列', retryable: false },
      })
    }

    let chatId: number
    try {
      chatId = decodeReplyTarget(message.replyTarget).chatId
    } catch (err) {
      return finish({
        ok: false,
        platformMessageId: null,
        queued: false,
        error: { code: 'PLATFORM_ERROR', message: (err as Error).message, retryable: false },
      })
    }

    const bubbles = splitIntoBubbles(message.text, {
      splitParagraphs: this.#splitParagraphs,
      maxBubbles: this.#maxBubbles,
    })
    if (bubbles.length === 0) {
      return finish({ ok: true, platformMessageId: null, queued: false, error: null })
    }

    let lastId: string | null = null
    for (let i = 0; i < bubbles.length; i++) {
      const bubble = bubbles[i]!
      if (i > 0) await this.#typingPause(chatId, bubble)
      let response: TelegramTransportResponse
      try {
        response = await this.client.sendMessage(chatId, bubble)
      } catch (err) {
        return finish({
          ok: false,
          platformMessageId: lastId,
          queued: false,
          // Only retry when nothing has been delivered yet, otherwise the gateway would resend the first bubbles.
          error: { code: 'PLATFORM_ERROR', message: (err as Error).message, retryable: i === 0 },
        })
      }
      if (!response.body.ok) {
        const mapped = this.#mapError(response)
        return finish({
          ok: false,
          platformMessageId: lastId,
          queued: false,
          error: i === 0 ? mapped : { ...mapped, retryable: false },
        })
      }
      const result = response.body.result as { message_id?: number } | undefined
      lastId = result?.message_id !== undefined ? `${chatId}:${result.message_id}` : lastId
    }
    return finish({ ok: true, platformMessageId: lastId, queued: false, error: null })
  }

  async #typingPause(chatId: number, nextBubble: string): Promise<void> {
    const ms = Math.min(this.#typingMaxMs, nextBubble.length * this.#typingMsPerChar)
    if (ms <= 0) return
    try {
      await this.client.sendChatAction(chatId, 'typing')
    } catch {
      /* the typing indicator is cosmetic */
    }
    await this.#sleep(ms)
  }

  #mapError(response: TelegramTransportResponse): NonNullable<MessageDeliveryResult['error']> {
    const code = response.body.error_code ?? response.status
    const description = response.body.description ?? ''
    if (code === 401 || code === 403) {
      // 403: the user blocked the bot or never pressed Start
      return { code: 'NO_PERMISSION', message: `Telegram 拒绝发送：${code} ${description}`.trim(), retryable: false }
    }
    if (code === 429) {
      const after = response.body.parameters?.retry_after
      return {
        code: 'RATE_LIMITED',
        message: `Telegram 限流${after !== undefined ? `，${after} 秒后可重试` : ''}`,
        retryable: true,
      }
    }
    return {
      code: 'PLATFORM_ERROR',
      message: `Telegram 错误：${code} ${description}`.trim(),
      retryable: code >= 500,
    }
  }
}
