/**
 * OneBot 11 HTTP API 客户端。
 *
 * OneBot 的调用约定非常简单：`POST {base}/{action}`，JSON 请求体，返回
 * `{ status: 'ok' | 'failed', retcode, data, wording? }`。
 * 鉴权走 `Authorization: Bearer <access_token>`（NapCat / Lagrange / SnowLuma 都支持）。
 *
 * 和 QQ 适配器一样把网络层抽成 `OneBotTransport`：
 * - 生产用 `FetchTransport`（Node 内置 fetch，零依赖）；
 * - 测试/离线演示用 `MockTransport`，可以断言实际发出了哪些 action。
 *
 * 注意：本项目只用 HTTP 上报（OneBot 的 "HTTP 事件上报" + "HTTP API"）两条通道，
 * **不用 WebSocket** —— Node 没有内置 WS 客户端，引 sdk 会破坏零依赖前提。
 */

export interface OneBotTransportRequest {
  url: string
  method: 'POST' | 'GET'
  headers: Record<string, string>
  body?: unknown
}

export interface OneBotTransportResponse {
  status: number
  /** 已解析的 JSON（解析失败时为原始文本） */
  body: unknown
}

export interface OneBotTransport {
  request(req: OneBotTransportRequest): Promise<OneBotTransportResponse>
}

export class FetchTransport implements OneBotTransport {
  #timeoutMs: number

  constructor(opts: { timeoutMs?: number } = {}) {
    this.#timeoutMs = opts.timeoutMs ?? 8000
  }

  async request(req: OneBotTransportRequest): Promise<OneBotTransportResponse> {
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
export class MockTransport implements OneBotTransport {
  readonly requests: OneBotTransportRequest[] = []
  #responses: Array<{ status: number; body: unknown }>
  #fallback: { status: number; body: unknown }

  constructor(
    responses: Array<{ status: number; body: unknown }> = [],
    fallback: { status: number; body: unknown } = { status: 200, body: { status: 'ok', retcode: 0, data: { message_id: 1 } } },
  ) {
    this.#responses = [...responses]
    this.#fallback = fallback
  }

  async request(req: OneBotTransportRequest): Promise<OneBotTransportResponse> {
    this.requests.push(structuredClone(req))
    const next = this.#responses.shift()
    return next ?? this.#fallback
  }

  lastRequest(): OneBotTransportRequest | null {
    return this.requests.length > 0 ? this.requests[this.requests.length - 1]! : null
  }

  /** 只取某个 action 的请求（便于断言）。 */
  callsTo(action: string): OneBotTransportRequest[] {
    return this.requests.filter((r) => r.url.endsWith(`/${action}`))
  }
}

export interface OneBotResponse<T = Record<string, unknown>> {
  status: 'ok' | 'failed' | string
  retcode: number
  data: T
  wording?: string
  /** HTTP 状态码（Mock 与真实都带） */
  httpStatus: number
}

export class OneBotApiClient {
  #transport: OneBotTransport
  #baseUrl: string
  #accessToken: string | null
  #now: () => number

  constructor(opts: { transport: OneBotTransport; baseUrl: string; accessToken?: string | null; now?: () => number }) {
    this.#transport = opts.transport
    this.#baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.#accessToken = opts.accessToken && opts.accessToken.length > 0 ? opts.accessToken : null
    this.#now = opts.now ?? Date.now
  }

  get baseUrl(): string {
    return this.#baseUrl
  }

  /** 通用调用：OneBot 的 action 都是同一形状，没必要一个接口写一遍。 */
  async call<T = Record<string, unknown>>(action: string, params: Record<string, unknown> = {}): Promise<OneBotResponse<T>> {
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.#accessToken) headers.authorization = `Bearer ${this.#accessToken}`
    const res = await this.#transport.request({
      url: `${this.#baseUrl}/${action}`,
      method: 'POST',
      headers,
      body: params,
    })
    const body = (res.body && typeof res.body === 'object' ? res.body : {}) as Partial<OneBotResponse<T>>
    return {
      status: typeof body.status === 'string' ? body.status : 'failed',
      retcode: typeof body.retcode === 'number' ? body.retcode : -1,
      data: (body.data ?? {}) as T,
      wording: body.wording,
      httpStatus: res.status,
    }
  }

  /**
   * 发私聊。
   *
   * `auto_escape: true` 是必须的：OneBot 的字符串消息会按 CQ 码解析，模型输出里只要出现
   * `[CQ:xxx]` 就会被网关当成指令。转义后它永远只是文本。
   */
  async sendPrivate(opts: { userId: string | number; text: string; autoEscape?: boolean }): Promise<OneBotResponse<{ message_id?: number | string }>> {
    return this.call('send_private_msg', {
      user_id: numericId(opts.userId),
      message: opts.text,
      auto_escape: opts.autoEscape !== false,
    })
  }

  async sendGroup(opts: { groupId: string | number; text: string; autoEscape?: boolean }): Promise<OneBotResponse<{ message_id?: number | string }>> {
    return this.call('send_group_msg', {
      group_id: numericId(opts.groupId),
      message: opts.text,
      auto_escape: opts.autoEscape !== false,
    })
  }

  /** 网关自检：拿机器人自己的 QQ 号（`/healthz` 用）。 */
  async loginInfo(): Promise<OneBotResponse<{ user_id?: number; nickname?: string }>> {
    return this.call('get_login_info')
  }

  /** 网关自检：在线状态与统计。 */
  async status(): Promise<OneBotResponse<Record<string, unknown>>> {
    return this.call('get_status')
  }

  /** 供日志使用：只暴露 baseUrl，不暴露 token。 */
  describe(): string {
    return `${this.#baseUrl}${this.#accessToken ? '（已配置 access_token）' : '（未配置 access_token）'}`
  }

  nowMs(): number {
    return this.#now()
  }
}

/**
 * OneBot 的 user_id / group_id 是整数。匿名化后我们传的是假名，只有 replyTarget
 * 里保留的原始 id 才会走到这里，因此保持「数字优先、字符串兜底」。
 */
function numericId(value: string | number): number | string {
  if (typeof value === 'number') return value
  const asNumber = Number(value)
  return Number.isFinite(asNumber) && Number.isInteger(asNumber) && String(asNumber) === value ? asNumber : value
}
