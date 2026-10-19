/**
 * OneBot 11 适配器。
 *
 * 职责边界与 QQ 适配器一致：只做协议转换 + 发送，不做身份判定、不写库、不改人格。
 *
 * 与 QQ 官方适配器的能力差异（这些差异来自平台，不是本项目放宽了标准）：
 *
 * | 能力 | QQ 官方 | OneBot |
 * |---|---|---|
 * | 主动消息 | 需账号额度 + 用户开关，默认 false | 网关能发就能发，默认 true |
 * | 被动回复窗口 | 单聊 60 分钟 / 群 5 分钟 | 无平台窗口（网关自身控频） |
 * | 同一条消息回复次数 | 单聊 4 次 / 群 5 次 | 无限（但会自限流） |
 * | 消息体裁 | 只支持文本 | 也只支持文本（图片/语音未实现） |
 *
 * 发送失败一律返回结构化 `MessageDeliveryResult`，绝不抛到引擎里。
 */

import type {
  MessageDeliveryResult,
  NormalizedMessage,
  OutboundMessage,
  PlatformAdapter,
  PlatformCapabilities,
} from '../protocol.ts'
import { InboundParseError } from '../protocol.ts'
import type { OneBotApiClient, OneBotResponse } from './api-client.ts'
import type { OneBotParseOptions } from './events.ts'
import { decodeReplyTarget, parseOneBotEvent } from './events.ts'

export interface OneBotAdapterOptions {
  client: OneBotApiClient
  /** 覆盖能力声明；默认值见 ONEBOT_DEFAULT_CAPABILITIES */
  capabilities?: Partial<PlatformCapabilities>
  /** 入站解析选项（群聊 @ 策略、匿名化、昵称） */
  parse?: OneBotParseOptions
  now?: () => number
  /** 单条文本上限（超过截断，避免网关拒收超大消息） */
  maxTextLength?: number
}

export const ONEBOT_DEFAULT_CAPABILITIES: PlatformCapabilities = {
  // OneBot 网关没有「主动消息额度」这回事，能连上就能推
  proactive: true,
  // 0 = 平台不限制（网关自己可能有频控，由网关配置决定）
  replyWindowMs: 0,
  maxRepliesPerMessage: 0,
  streaming: false,
  // secret 可选：没配置时不强制校验，由部署者承担内网暴露风险
  webhookSignature: false,
}

export class OneBotAdapter implements PlatformAdapter {
  readonly platform = 'onebot'
  readonly capabilities: PlatformCapabilities
  #client: OneBotApiClient
  #now: () => number
  #maxTextLength: number
  #autoEscape: boolean
  #parseOptions: OneBotParseOptions
  /** 最近一次发送结果，便于测试与审计 */
  lastResult: MessageDeliveryResult | null = null

  constructor(opts: OneBotAdapterOptions) {
    this.#client = opts.client
    this.capabilities = { ...ONEBOT_DEFAULT_CAPABILITIES, ...(opts.capabilities ?? {}) }
    this.#now = opts.now ?? Date.now
    this.#maxTextLength = opts.maxTextLength ?? 1500
    this.#autoEscape = true
    this.#parseOptions = { ...(opts.parse ?? {}) }
  }

  parseInbound(raw: unknown): NormalizedMessage | null {
    return parseOneBotEvent(raw, this.#parseOptions)
  }

  /** 供 `/healthz` 与运维日志使用：不暴露 token。 */
  describe(): string {
    return this.#client.describe()
  }

  async refreshLoginInfo(): Promise<{ selfId: string | null; nickname: string | null; online: boolean }> {
    try {
      const res = await this.#client.loginInfo()
      const data = res.data as { user_id?: number | string; nickname?: string }
      const selfId = data.user_id === undefined ? null : String(data.user_id)
      return { selfId, nickname: typeof data.nickname === 'string' ? data.nickname : null, online: res.status === 'ok' && res.retcode === 0 }
    } catch {
      return { selfId: null, nickname: null, online: false }
    }
  }

  async send(message: OutboundMessage): Promise<MessageDeliveryResult> {
    const started = this.#now()
    const finish = (partial: Omit<MessageDeliveryResult, 'latencyMs'>): MessageDeliveryResult => {
      const result = { ...partial, latencyMs: this.#now() - started }
      this.lastResult = result
      return result
    }

    // 1) 主动消息：适配器没声明能力时只入队，绝不强行发送（与 QQ 适配器同一条规矩）
    if (message.proactive && !this.capabilities.proactive) {
      return finish({
        ok: false,
        platformMessageId: null,
        queued: true,
        error: {
          code: 'NOT_SUPPORTED',
          message: '当前 OneBot 适配器未声明主动消息能力，消息保留在 CharacterLife 待发送队列',
          retryable: false,
        },
      })
    }

    const text = message.text.trim()
    if (text.length === 0) {
      return finish({
        ok: false,
        platformMessageId: null,
        queued: false,
        error: { code: 'PLATFORM_ERROR', message: '空文本不发送', retryable: false },
      })
    }

    let target: ReturnType<typeof decodeReplyTarget>
    try {
      target = decodeReplyTarget(message.replyTarget)
    } catch (err) {
      return finish({
        ok: false,
        platformMessageId: null,
        queued: false,
        error: {
          code: 'PLATFORM_ERROR',
          message: `回复目标非法：${(err as InboundParseError).message}`,
          retryable: false,
        },
      })
    }
    // scene 必须与发送目标一致，否则会出现「群消息发到私聊」这类串台
    if (target.scene === 'group' && message.scene !== 'group') {
      return finish({
        ok: false,
        platformMessageId: null,
        queued: false,
        error: { code: 'PLATFORM_ERROR', message: '回复目标与消息场景不一致（group）', retryable: false },
      })
    }
    if (target.scene === 'c2c' && message.scene === 'group') {
      return finish({
        ok: false,
        platformMessageId: null,
        queued: false,
        error: { code: 'PLATFORM_ERROR', message: '回复目标与消息场景不一致（c2c）', retryable: false },
      })
    }

    const content = this.#truncate(text)
    let response: OneBotResponse<{ message_id?: number | string }>
    try {
      response =
        target.scene === 'group'
          ? await this.#client.sendGroup({ groupId: target.target, text: content, autoEscape: this.#autoEscape })
          : await this.#client.sendPrivate({ userId: target.target, text: content, autoEscape: this.#autoEscape })
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
    response: OneBotResponse<{ message_id?: number | string }>,
    finish: (partial: Omit<MessageDeliveryResult, 'latencyMs'>) => MessageDeliveryResult,
  ): MessageDeliveryResult {
    if (response.httpStatus === 401 || response.httpStatus === 403) {
      return finish({
        ok: false,
        platformMessageId: null,
        queued: false,
        error: {
          code: 'NO_PERMISSION',
          message: `网关拒绝：HTTP ${response.httpStatus}（检查 access_token）`,
          retryable: false,
        },
      })
    }
    if (response.httpStatus === 429) {
      return finish({
        ok: false,
        platformMessageId: null,
        queued: false,
        error: { code: 'RATE_LIMITED', message: '网关限流（HTTP 429）', retryable: true },
      })
    }
    if (response.status === 'ok' && response.retcode === 0) {
      const id = response.data?.message_id
      return finish({
        ok: true,
        platformMessageId: id === undefined || id === null ? null : String(id),
        queued: false,
        error: null,
      })
    }
    return finish({
      ok: false,
      platformMessageId: null,
      queued: false,
      error: {
        code: 'PLATFORM_ERROR',
        message: `网关错误：HTTP ${response.httpStatus} retcode=${response.retcode}${response.wording ? ` ${response.wording}` : ''}`,
        retryable: response.httpStatus >= 500 || response.retcode < 0,
      },
    })
  }

  #truncate(text: string): string {
    if (text.length <= this.#maxTextLength) return text
    return `${text.slice(0, this.#maxTextLength - 1)}…`
  }
}

export function isOneBotParseError(err: unknown): err is InboundParseError {
  return err instanceof InboundParseError
}
