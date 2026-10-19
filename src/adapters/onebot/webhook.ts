/**
 * OneBot 11 HTTP 事件上报的签名校验。
 *
 * 规范（OneBot 11「HTTP 上报」）：
 *   - 网关配置了 `secret` 时，每个上报请求都带 `X-Signature: sha1=<hex>`；
 *   - 签名内容 = `HMAC-SHA1(原始请求体, secret)`，十六进制小写。
 *
 * 与 QQ 官方 Webhook 的关键差异：
 *   - OneBot 的 `secret` 是**可选**的 → 没配置时不拒绝，但必须显式记日志；
 *   - 没有时间戳防重放 → 重放防护靠 `processed_messages` 去重表（message_id 幂等）。
 *
 * 因此这个文件只负责「请求是不是网关发的」，不负责「这条消息是不是新的」。
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

export interface OneBotSignatureResult {
  ok: boolean
  reason: 'OK' | 'NOT_CONFIGURED' | 'MISSING_HEADER' | 'BAD_SIGNATURE' | 'UNSUPPORTED_ALGORITHM'
}

export interface OneBotSignatureOptions {
  /** 网关里配置的 secret；不配置时返回 ok + NOT_CONFIGURED（由调用方决定是否放行） */
  secret?: string | null
  rawBody: string
  /** 请求头 X-Signature 的原始值，形如 `sha1=ab12…` */
  signatureHeader: string | undefined
}

export function hmacSha1Hex(rawBody: string, secret: string): string {
  return createHmac('sha1', secret).update(rawBody, 'utf8').digest('hex')
}

function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

export function verifyOneBotSignature(opts: OneBotSignatureOptions): OneBotSignatureResult {
  if (!opts.secret || opts.secret.length === 0) {
    return { ok: true, reason: 'NOT_CONFIGURED' }
  }
  if (!opts.signatureHeader) {
    return { ok: false, reason: 'MISSING_HEADER' }
  }
  const [algo, ...rest] = opts.signatureHeader.split('=')
  if (!algo || algo.toLowerCase() !== 'sha1' || rest.length === 0) {
    // 只接受 sha1=…；其他形态（例如裸 hex）不猜，直接拒绝，避免弱比较
    return { ok: false, reason: 'UNSUPPORTED_ALGORITHM' }
  }
  const provided = rest.join('=').trim().toLowerCase()
  const expected = hmacSha1Hex(opts.rawBody, opts.secret)
  return safeEqualHex(provided, expected) ? { ok: true, reason: 'OK' } : { ok: false, reason: 'BAD_SIGNATURE' }
}
