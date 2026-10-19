/**
 * QQ 官方 HTTP API 客户端。
 *
 * 只实现本项目用到的三个接口 + 一个 token 接口，且把网络层抽象成 `QQTransport`：
 * - 生产环境用 `FetchTransport`（Node 内置 fetch）；
 * - 测试/离线演示用 `MockTransport`，可以把请求记录下来并断言，不需要任何真实凭证。
 *
 * 官方端点（按 QQ 开放平台 v2 文档）：
 *   POST https://bots.qq.com/app/getAppAccessToken
 *   POST https://api.sgroup.qq.com/v2/users/{openid}/messages          C2C 单聊
 *   POST https://api.sgroup.qq.com/v2/groups/{group_openid}/messages   群聊
 *   POST https://api.sgroup.qq.com/channels/{channel_id}/messages      频道
 */

export interface QQTransportRequest {
  url: string
  method: 'POST' | 'GET'
  headers: Record<string, string>
  body: unknown
}

export interface QQTransportResponse {
  status: number
  /** 已解析的 JSON（解析失败时为原始文本） */
  body: unknown
}

export interface QQTransport {
  request(req: QQTransportRequest): Promise<QQTransportResponse>
}

export class FetchTransport implements QQTransport {
  #timeoutMs: number
  constructor(opts: { timeoutMs?: number } = {}) {
    this.#timeoutMs = opts.timeoutMs ?? 8000
  }

  async request(req: QQTransportRequest): Promise<QQTransportResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
        signal: controller.signal,
      })
      const text = await res.text()
      let body: unknown = text
      try {
        body = JSON.parse(text) as unknown
      } catch {
        /* 保留原始文本 */
      }
      return { status: res.status, body }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** 离线测试用：记录所有请求，按预设脚本返回响应。 */
export class MockTransport implements QQTransport {
  readonly requests: QQTransportRequest[] = []
  #responses: Array<{ status: number; body: unknown }>
  #fallback: { status: number; body: unknown }

  constructor(responses: Array<{ status: number; body: unknown }> = [], fallback = { status: 200, body: {} }) {
    this.#responses = [...responses]
    this.#fallback = fallback
  }

  async request(req: QQTransportRequest): Promise<QQTransportResponse> {
    this.requests.push(structuredClone(req))
    const next = this.#responses.shift()
    return next ?? this.#fallback
  }

  lastRequest(): QQTransportRequest | null {
    return this.requests.length > 0 ? this.requests[this.requests.length - 1]! : null
  }
}

export interface QQCredentials {
  appId: string
  appSecret: string
}

export class QQApiClient {
  #transport: QQTransport
  #credentials: QQCredentials
  #apiBase: string
  #tokenBase: string
  #token: { value: string; expiresAtMs: number } | null = null
  #now: () => number

  constructor(opts: {
    transport: QQTransport
    credentials: QQCredentials
    apiBase?: string
    tokenBase?: string
    now?: () => number
  }) {
    this.#transport = opts.transport
    this.#credentials = opts.credentials
    this.#apiBase = (opts.apiBase ?? 'https://api.sgroup.qq.com').replace(/\/+$/, '')
    this.#tokenBase = (opts.tokenBase ?? 'https://bots.qq.com').replace(/\/+$/, '')
    this.#now = opts.now ?? Date.now
  }

  async getAccessToken(): Promise<string> {
    if (this.#token && this.#token.expiresAtMs > this.#now() + 30_000) {
      return this.#token.value
    }
    const res = await this.#transport.request({
      url: `${this.#tokenBase}/app/getAppAccessToken`,
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { appId: this.#credentials.appId, clientSecret: this.#credentials.appSecret },
    })
    const body = res.body as { access_token?: string; expires_in?: number | string } | undefined
    if (res.status !== 200 || !body?.access_token) {
      throw new Error(`获取 QQ access_token 失败：HTTP ${res.status}`)
    }
    const expiresInSec = Number(body.expires_in ?? 7200)
    this.#token = {
      value: body.access_token,
      expiresAtMs: this.#now() + (Number.isFinite(expiresInSec) ? expiresInSec : 7200) * 1000,
    }
    return this.#token.value
  }

  /** C2C 单聊 */
  async sendC2C(opts: {
    openid: string
    content: string
    msgId?: string | null
    msgSeq?: number
  }): Promise<QQTransportResponse> {
    const token = await this.getAccessToken()
    const body: Record<string, unknown> = { content: opts.content, msg_type: 0 }
    if (opts.msgId) body.msg_id = opts.msgId
    if (opts.msgSeq !== undefined) body.msg_seq = opts.msgSeq
    return this.#transport.request({
      url: `${this.#apiBase}/v2/users/${encodeURIComponent(opts.openid)}/messages`,
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `QQBot ${token}` },
      body,
    })
  }

  /** 群聊（被动回复必须带 msg_id） */
  async sendGroup(opts: {
    groupOpenid: string
    content: string
    msgId?: string | null
    msgSeq?: number
  }): Promise<QQTransportResponse> {
    const token = await this.getAccessToken()
    const body: Record<string, unknown> = { content: opts.content, msg_type: 0 }
    if (opts.msgId) body.msg_id = opts.msgId
    if (opts.msgSeq !== undefined) body.msg_seq = opts.msgSeq
    return this.#transport.request({
      url: `${this.#apiBase}/v2/groups/${encodeURIComponent(opts.groupOpenid)}/messages`,
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `QQBot ${token}` },
      body,
    })
  }

  /** 频道 */
  async sendChannel(opts: {
    channelId: string
    content: string
    msgId?: string | null
  }): Promise<QQTransportResponse> {
    const token = await this.getAccessToken()
    const body: Record<string, unknown> = { content: opts.content }
    if (opts.msgId) body.msg_id = opts.msgId
    return this.#transport.request({
      url: `${this.#apiBase}/channels/${encodeURIComponent(opts.channelId)}/messages`,
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `QQBot ${token}` },
      body,
    })
  }
}
