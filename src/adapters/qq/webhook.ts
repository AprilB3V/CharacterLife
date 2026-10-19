/**
 * QQ Webhook 签名校验（Ed25519）。
 *
 * QQ 开放平台的 Webhook 回调会带：
 *   X-Signature-Ed25519（签名 hex）
 *   X-Signature-Timestamp（时间戳字符串）
 * 签名内容 = `${timestamp}${rawBody}`，公钥由 AppSecret 派生。
 *
 * 诚实说明：派生算法按社区/官方 SDK 的公开做法实现（把 AppSecret 截断/补零成 32 字节
 * 作为 ed25519 seed），**没有拿到真实回调做过验证**。因此：
 * - 支持直接注入 `publicKeyHex`（测试与自建网关用）；
 * - 校验失败一律拒绝，不会「失败放行」。
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify as cryptoVerify,
  timingSafeEqual,
} from 'node:crypto'

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

export function ed25519SeedFromSecret(appSecret: string): Buffer {
  const secret = Buffer.from(appSecret, 'utf8')
  if (secret.length === 32) return Buffer.from(secret)
  if (secret.length > 32) return secret.subarray(0, 32)
  // 不足 32 字节：用 sha256 补齐，避免简单重复造成的弱种子
  return createHash('sha256').update(secret).digest()
}

/** 由 AppSecret 派生 ed25519 公钥（hex，32 字节）。 */
export function derivePublicKeyHex(appSecret: string): string {
  const seed = ed25519SeedFromSecret(appSecret)
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' })
  const publicKey = createPublicKey(privateKey)
  const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer
  // spki 末 32 字节即原始公钥
  return der.subarray(der.length - 32).toString('hex')
}

export interface SignatureVerifyOptions {
  appSecret?: string
  /** 直接提供公钥（测试/自建网关）；优先级高于 appSecret */
  publicKeyHex?: string
  rawBody: string
  signatureHex: string | undefined
  timestamp: string | undefined
  /** 允许的时间偏差，默认 5 分钟，防重放 */
  maxSkewMs?: number
  now?: () => number
}

export interface SignatureVerifyResult {
  ok: boolean
  reason: 'OK' | 'MISSING_HEADERS' | 'BAD_SIGNATURE' | 'TIMESTAMP_SKEW' | 'NOT_CONFIGURED'
}

export function verifyQQWebhookSignature(opts: SignatureVerifyOptions): SignatureVerifyResult {
  if (!opts.signatureHex || !opts.timestamp) {
    return { ok: false, reason: 'MISSING_HEADERS' }
  }
  const now = (opts.now ?? Date.now)()
  const maxSkew = opts.maxSkewMs ?? 5 * 60 * 1000
  const ts = Number(opts.timestamp)
  // QQ 的 timestamp 是秒；兼容毫秒
  const tsMs = Number.isFinite(ts) ? (ts < 1e12 ? ts * 1000 : ts) : NaN
  if (!Number.isFinite(tsMs) || Math.abs(now - tsMs) > maxSkew) {
    return { ok: false, reason: 'TIMESTAMP_SKEW' }
  }

  let publicKeyHex: string
  if (opts.publicKeyHex) {
    publicKeyHex = opts.publicKeyHex
  } else if (opts.appSecret) {
    publicKeyHex = derivePublicKeyHex(opts.appSecret)
  } else {
    return { ok: false, reason: 'NOT_CONFIGURED' }
  }

  try {
    const keyDer = Buffer.concat([
      // spki 固定头 12 字节：30 2a 30 05 06 03 2b 65 70 03 21 00
      Buffer.from('302a300506032b6570032100', 'hex'),
      Buffer.from(publicKeyHex, 'hex'),
    ])
    const publicKey = createPublicKey({ key: keyDer, format: 'der', type: 'spki' })
    const message = Buffer.from(`${opts.timestamp}${opts.rawBody}`, 'utf8')
    const signature = Buffer.from(opts.signatureHex, 'hex')
    if (signature.length !== 64) return { ok: false, reason: 'BAD_SIGNATURE' }
    const ok = cryptoVerify(null, message, publicKey, signature)
    return { ok, reason: ok ? 'OK' : 'BAD_SIGNATURE' }
  } catch {
    return { ok: false, reason: 'BAD_SIGNATURE' }
  }
}

/** 常量时间比较，供其他校验（例如 API token）复用。 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

/**
 * Webhook 回调地址校验（QQ 的 op=13 挑战）。
 *
 * 平台发送 `{ plain_token, event_ts }`，要求用 AppSecret 派生的 ed25519 私钥对
 * `${event_ts}${plain_token}` 签名，回 `{ plain_token, signature }`。
 * 同样标注：派生算法未经真实回调验证。
 */
export function signWebhookChallenge(opts: {
  appSecret: string
  plainToken: string
  eventTs: string
}): { plain_token: string; signature: string } {
  const seed = ed25519SeedFromSecret(opts.appSecret)
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' })
  const signature = sign(null, Buffer.from(`${opts.eventTs}${opts.plainToken}`, 'utf8'), privateKey)
  return { plain_token: opts.plainToken, signature: signature.toString('hex') }
}

/** 判断是否是平台的回调地址校验事件。 */
export function isUrlVerificationEvent(raw: unknown): raw is { op: number; d: { plain_token: string; event_ts: string } } {
  if (!raw || typeof raw !== 'object') return false
  const v = raw as { op?: unknown; d?: unknown }
  if (v.op !== 13 || !v.d || typeof v.d !== 'object') return false
  const d = v.d as Record<string, unknown>
  return typeof d.plain_token === 'string' && (typeof d.event_ts === 'string' || typeof d.event_ts === 'number')
}
