/**
 * SillyTavern 适配器：只有「接收」语义。
 *
 * 酒馆是通过 HTTP 请求/响应交互的，回复直接写回响应体，不需要 outbound 通道。
 * 因此这里的 `send()` 只做记录（返回 ok），真正的响应由 API Server 负责。
 * 这样设计的好处：酒馆路径与 QQ 路径共用同一个 Gateway 与同一套身份/记忆逻辑。
 */

import type {
  MessageDeliveryResult,
  NormalizedMessage,
  OutboundMessage,
  PlatformAdapter,
  PlatformCapabilities,
} from '../protocol.ts'
import { buildNormalizedMessage } from './openai.ts'
import type { OpenAIChatRequest, SillyTavernIdentityOptions } from './openai.ts'

export class SillyTavernAdapter implements PlatformAdapter {
  readonly platform = 'sillytavern'
  readonly capabilities: PlatformCapabilities = {
    // 本地单用户实例：不主动推送；由客户端发起请求
    proactive: false,
    replyWindowMs: 0,
    maxRepliesPerMessage: 0,
    streaming: true,
    webhookSignature: false,
  }
  /** 记录最近一次 outbound（HTTP 层其实不用，但便于测试与审计） */
  lastOutbound: OutboundMessage | null = null

  parseInbound(): NormalizedMessage | null {
    // 酒馆的入站不是「事件流」，而是 HTTP 请求；由 server 调用 build() 构造
    return null
  }

  /** 供 API Server 调用：OpenAI 请求 → NormalizedMessage */
  build(
    request: OpenAIChatRequest,
    identity: SillyTavernIdentityOptions,
    requestId?: string | null,
  ): NormalizedMessage {
    return buildNormalizedMessage({ request, identity, requestId, now: Date.now() })
  }

  async send(message: OutboundMessage): Promise<MessageDeliveryResult> {
    this.lastOutbound = message
    return { ok: true, platformMessageId: null, queued: false, error: null, latencyMs: 0 }
  }
}
