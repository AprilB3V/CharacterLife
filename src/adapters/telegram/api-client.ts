/**
 * Telegram Bot API 客户端。
 *
 * 只实现本项目用到的四个方法：getMe / getUpdates / sendMessage / sendChatAction。
 * 网络层抽象成 `TelegramTransport`：
 * - 生产环境用 `FetchTransport`（Node 内置 fetch）；
 * - 测试/离线演示用 `MockTransport`，按脚本返回响应并记录请求，不需要真实 token。
 *
 * 安全约束：bot token 会出现在请求 URL 里（Bot API 的规定），所以**任何日志、错误信息都不能带 URL**。
 * 本文件抛出的错误只包含方法名和状态码。
 *
 * 官方文档：https://core.telegram.org/bots/api
 */

export interface TelegramTransportRequest {
  /** Bot API 方法名，例如 sendMessage */
  method: string
  params: Record<string, unknown>
  /** 本次请求的超时；长轮询需要比 getUpdates 的 timeout 更长 */
  timeoutMs: number
  signal?: AbortSignal
}

/** Bot API 统一响应体。 */
export interface TelegramApiResponse {
  ok: boolean
  result?: unknown
  error_code?: number
  description?: string
  parameters?: { retry_after?: number; migrate_to_chat_id?: number }
}

export interface TelegramTransportResponse {
  status: number
  body: TelegramApiResponse
}

export interface TelegramTransport {
  request(req: TelegramTransportRequest): Promise<TelegramTransportResponse>
}

export class FetchTransport implements TelegramTransport {
  #token: string
  #apiBase: string

  constructor(opts: { token: string; apiBase?: string }) {
    this.#token = opts.token
    this.#apiBase = (opts.apiBase ?? 'https://api.telegram.org').replace(/\/+$/, '')
  }

  async request(req: TelegramTransportRequest): Promise<TelegramTransportResponse> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), req.timeoutMs)
    const onOuterAbort = (): void => controller.abort()
    req.signal?.addEventListener('abort', onOuterAbort, { once: true })
    try {
      const res = await fetch(`${this.#apiBase}/bot${this.#token}/${req.method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(req.params),
        signal: controller.signal,
      })
      const text = await res.text()
      let body: TelegramApiResponse
      try {
        body = JSON.parse(text) as TelegramApiResponse
      } catch {
        body = { ok: false, error_code: res.status, description: 'non-JSON response' }
      }
      return { status: res.status, body }
    } catch (err) {
      // Never surface the underlying error message as-is: some runtimes include the URL (and the token).
      const aborted = controller.signal.aborted
      throw new Error(`Telegram ${req.method} ${aborted ? 'aborted or timed out' : 'network error'}`, {
        cause: (err as Error).name,
      })
    } finally {
      clearTimeout(timer)
      req.signal?.removeEventListener('abort', onOuterAbort)
    }
  }
}

/** 离线测试用：记录所有请求，按方法名或顺序返回预设响应。 */
export class MockTransport implements TelegramTransport {
  readonly requests: TelegramTransportRequest[] = []
  #queue: TelegramTransportResponse[]
  #byMethod = new Map<string, TelegramTransportResponse[]>()
  #fallback: TelegramTransportResponse

  constructor(
    responses: TelegramTransportResponse[] = [],
    fallback: TelegramTransportResponse = { status: 200, body: { ok: true, result: { message_id: 1 } } },
  ) {
    this.#queue = [...responses]
    this.#fallback = fallback
  }

  /** 为某个方法排队预设响应（优先于顺序队列）。 */
  enqueue(method: string, response: TelegramTransportResponse): void {
    const list = this.#byMethod.get(method) ?? []
    list.push(response)
    this.#byMethod.set(method, list)
  }

  async request(req: TelegramTransportRequest): Promise<TelegramTransportResponse> {
    const { signal, ...rest } = req
    this.requests.push(structuredClone(rest))
    if (signal?.aborted) throw new Error(`Telegram ${req.method} aborted or timed out`)
    const scripted = this.#byMethod.get(req.method)?.shift()
    if (scripted) return scripted
    if (req.method === 'getUpdates') {
      // Without a scripted batch, behave like an idle long poll: yield to the event loop
      // (a real poll would block), then return nothing.
      await new Promise((resolve) => setTimeout(resolve, 5))
      if (signal?.aborted) throw new Error(`Telegram ${req.method} aborted or timed out`)
      return { status: 200, body: { ok: true, result: [] } }
    }
    return this.#queue.shift() ?? this.#fallback
  }

  calls(method: string): TelegramTransportRequest[] {
    return this.requests.filter((r) => r.method === method)
  }
}

/** Bot API 调用失败（ok=false），带状态码与平台给的重试建议。 */
export class TelegramApiError extends Error {
  readonly method: string
  readonly status: number
  readonly retryAfterSec: number | null

  constructor(method: string, response: TelegramTransportResponse) {
    const code = response.body.error_code ?? response.status
    super(`Telegram ${method} failed: ${code} ${response.body.description ?? ''}`.trim())
    this.name = 'TelegramApiError'
    this.method = method
    this.status = code
    this.retryAfterSec = response.body.parameters?.retry_after ?? null
  }
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000

export class TelegramApiClient {
  #transport: TelegramTransport

  constructor(opts: { transport: TelegramTransport }) {
    this.#transport = opts.transport
  }

  /** 底层调用：返回原始响应，由调用方决定如何映射错误（适配器需要细分错误码）。 */
  async call(
    method: string,
    params: Record<string, unknown>,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<TelegramTransportResponse> {
    return this.#transport.request({
      method,
      params,
      timeoutMs: opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      signal: opts.signal,
    })
  }

  /** 调用并要求成功，否则抛 TelegramApiError。 */
  async callOk<T>(
    method: string,
    params: Record<string, unknown>,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const res = await this.call(method, params, opts)
    if (!res.body.ok) throw new TelegramApiError(method, res)
    return res.body.result as T
  }

  async getMe(): Promise<{ id: number; username?: string; first_name?: string }> {
    return this.callOk('getMe', {})
  }

  /** 长轮询；timeoutSec 是服务端挂起时长，请求超时会自动多留 10 秒余量。 */
  async getUpdates(opts: { offset: number | null; timeoutSec: number; signal?: AbortSignal }): Promise<unknown[]> {
    const params: Record<string, unknown> = {
      timeout: opts.timeoutSec,
      allowed_updates: ['message'],
    }
    if (opts.offset !== null) params.offset = opts.offset
    const result = await this.callOk<unknown>('getUpdates', params, {
      timeoutMs: (opts.timeoutSec + 10) * 1000,
      signal: opts.signal,
    })
    return Array.isArray(result) ? result : []
  }

  async sendChatAction(chatId: number | string, action = 'typing'): Promise<void> {
    await this.call('sendChatAction', { chat_id: chatId, action })
  }

  async sendMessage(chatId: number | string, text: string): Promise<TelegramTransportResponse> {
    // Plain text on purpose: model output is untrusted and parse_mode would make it fail on stray markup.
    return this.call('sendMessage', { chat_id: chatId, text, link_preview_options: { is_disabled: true } })
  }
}
