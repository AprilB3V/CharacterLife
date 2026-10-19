/**
 * QQ 官方机器人适配器。
 *
 * 职责边界（很重要）：
 * - 只做协议转换 + 发送；不做身份判定、不写数据库、不改人格；
 * - 平台能力（主动消息、回复窗口、频率）由 capabilities 显式声明，
 *   **不假设 SDK 有接口就等于账号有权限**；
 * - 主动消息不可用时**不入队到平台**，而是返回 `queued` 交给 CharacterLife 的待发送队列。
 */

import type {
  MessageDeliveryResult,
  NormalizedMessage,
  OutboundMessage,
  PlatformAdapter,
  PlatformCapabilities,
} from '../protocol.ts'
import { InboundParseError } from '../protocol.ts'
import { decodeReplyTarget, parseQQEvent } from './events.ts'
import type { QQApiClient, QQTransportResponse } from './api-client.ts'

export interface QQAdapterOptions {
  client: QQApiClient
  /** 覆盖能力声明（默认按官方文档的场景化限制） */
  capabilities?: Partial<PlatformCapabilities>
  now?: () => number
  /** QQ 单条文本上限（保守截断，避免平台直接拒收） */
  maxTextLength?: number
}

/**
 * 官方文档的被动回复限制（按场景）：
 * - 单聊：60 分钟内可回复 4 次
 * - 群聊：5 分钟内可回复 5 次
 * - 频道：5 分钟内（次数未声明上限）
 * - 频道私信：5 分钟内（次数未声明上限）
 *
 * 来源：https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html
 * 核查日期：2026-10-19（抓取时页面标注「上次更新 7/21/2026」）
 */
export const QQ_SCENE_LIMITS = {
  c2c: { windowMs: 60 * 60 * 1000, maxReplies: 4 },
  group: { windowMs: 5 * 60 * 1000, maxReplies: 5 },
  guild: { windowMs: 5 * 60 * 1000, maxReplies: 0 },
  dm: { windowMs: 5 * 60 * 1000, maxReplies: 0 },
  local: { windowMs: 0, maxReplies: 0 },
} as const

const DEFAULT_CAPABILITIES: PlatformCapabilities = {
  // 主动消息受「用户开关 + 账号额度」双重限制，默认按不可用处理
  proactive: false,
  // 未按场景细分时的兜底值：取最严格的一档
  replyWindowMs: 5 * 60 * 1000,
  maxRepliesPerMessage: 4,
  streaming: false,
  webhookSignature: true,
}

export class QQAdapter implements PlatformAdapter {
  readonly platform = 'qq'
  readonly capabilities: PlatformCapabilities
  #client: QQApiClient
  #now: () => number
  #maxTextLength: number
  /** 场景级限制（官方文档口径）；capabilities 里的值作为整体覆盖 */
  #sceneLimits: Record<string, { windowMs: number; maxReplies: number }>
  /** 每条入站消息已回复次数（用于 msg_seq 与上限） */
  #replyCounts = new Map<string, number>()
  /** 最近一次发送结果，便于测试与审计 */
  lastResult: MessageDeliveryResult | null = null

  constructor(opts: QQAdapterOptions) {
    this.#client = opts.client
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...(opts.capabilities ?? {}) }
    this.#now = opts.now ?? Date.now
    this.#maxTextLength = opts.maxTextLength ?? 1000
    const overrideWindow = opts.capabilities?.replyWindowMs
    const overrideMax = opts.capabilities?.maxRepliesPerMessage
    this.#sceneLimits = Object.fromEntries(
      Object.entries(QQ_SCENE_LIMITS).map(([scene, limit]) => [
        scene,
        {
          windowMs: overrideWindow !== undefined ? overrideWindow : limit.windowMs,
          maxReplies: overrideMax !== undefined ? overrideMax : limit.maxReplies,
        },
      ]),
    )
  }

  parseInbound(raw: unknown): NormalizedMessage | null {
    return parseQQEvent(raw)
  }

  async send(message: OutboundMessage): Promise<MessageDeliveryResult> {
    const started = this.#now()
    const finish = (partial: Omit<MessageDeliveryResult, 'latencyMs'>): MessageDeliveryResult => {
      const result = { ...partial, latencyMs: this.#now() - started }
      this.lastResult = result
      return result
    }

    // 1) 主动消息：平台能力不允许时只入队，绝不强行发送
    if (message.proactive && !this.capabilities.proactive) {
      return finish({
        ok: false,
        platformMessageId: null,
        queued: true,
        error: {
          code: 'NOT_SUPPORTED',
          message: '当前 QQ 账号未声明主动消息能力，消息保留在 CharacterLife 待发送队列',
          retryable: false,
        },
      })
    }

    // 2) 被动回复窗口与条数限制（按场景，见 QQ_SCENE_LIMITS）
    if (!message.proactive) {
      const limits = this.#sceneLimits[message.scene] ?? { windowMs: 0, maxReplies: 0 }
      if (limits.windowMs > 0 && message.inboundAt !== undefined && this.#now() - message.inboundAt > limits.windowMs) {
        return finish({
          ok: false,
          platformMessageId: null,
          queued: true,
          error: {
            code: 'WINDOW_EXPIRED',
            message: `超过 ${message.scene} 被动回复窗口 ${limits.windowMs}ms，已转为待发送`,
            retryable: false,
          },
        })
      }
      const key = message.replyToMessageId ?? 'unknown'
      const used = this.#replyCounts.get(key) ?? 0
      if (limits.maxReplies > 0 && used >= limits.maxReplies) {
        return finish({
          ok: false,
          platformMessageId: null,
          queued: true,
          error: {
            code: 'RATE_LIMITED',
            message: `同一 ${message.scene} 消息已达到 ${limits.maxReplies} 次回复上限`,
            retryable: false,
          },
        })
      }
      this.#replyCounts.set(key, used + 1)
      // 只保留最近 500 条计数，避免内存增长
      if (this.#replyCounts.size > 500) {
        const first = this.#replyCounts.keys().next().value
        if (first !== undefined) this.#replyCounts.delete(first)
      }
    }

    const target = decodeReplyTarget(message.replyTarget)
    const content = this.#truncate(message.text)
    const msgId = message.proactive ? null : message.replyToMessageId
    const msgSeq = message.proactive ? undefined : (this.#replyCounts.get(message.replyToMessageId ?? 'unknown') ?? 1)

    let response: QQTransportResponse
    try {
      if (target.scene === 'c2c') {
        response = await this.#client.sendC2C({ openid: target.target, content, msgId, msgSeq })
      } else if (target.scene === 'group') {
        response = await this.#client.sendGroup({ groupOpenid: target.target, content, msgId, msgSeq })
      } else {
        response = await this.#client.sendChannel({ channelId: target.target, content, msgId })
      }
    } catch (err) {
      return finish({
        ok: false,
        platformMessageId: null,
        queued: false,
        error: { code: 'PLATFORM_ERROR', message: (err as Error).message, retryable: true },
      })
    }

    return this.#mapResponse(response, finish)
  }

  #mapResponse(
    response: QQTransportResponse,
    finish: (partial: Omit<MessageDeliveryResult, 'latencyMs'>) => MessageDeliveryResult,
  ): MessageDeliveryResult {
    const body = response.body as { id?: string; code?: number; message?: string } | undefined
    if (response.status >= 200 && response.status < 300) {
      return finish({ ok: true, platformMessageId: body?.id ?? null, queued: false, error: null })
    }
    if (response.status === 401 || response.status === 403) {
      return finish({
        ok: false,
        platformMessageId: null,
        queued: false,
        error: {
          code: 'NO_PERMISSION',
          message: `平台拒绝：HTTP ${response.status} ${body?.message ?? ''}`.trim(),
          retryable: false,
        },
      })
    }
    if (response.status === 429) {
      return finish({
        ok: false,
        platformMessageId: null,
        queued: false,
        error: { code: 'RATE_LIMITED', message: '平台限流（HTTP 429）', retryable: true },
      })
    }
    return finish({
      ok: false,
      platformMessageId: null,
      queued: false,
      error: {
        code: 'PLATFORM_ERROR',
        message: `平台错误：HTTP ${response.status} ${body?.message ?? ''}`.trim(),
        retryable: response.status >= 500,
      },
    })
  }

  #truncate(text: string): string {
    if (text.length <= this.#maxTextLength) return text
    return `${text.slice(0, this.#maxTextLength - 1)}…`
  }
}

/** 便于测试：确保解析错误是受控类型。 */
export function isQQParseError(err: unknown): err is InboundParseError {
  return err instanceof InboundParseError
}
