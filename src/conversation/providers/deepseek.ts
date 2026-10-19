/**
 * DeepSeek Provider —— 真实模型接入。
 *
 * 只依赖 Node 内置 fetch，不引入 SDK：
 * - 路由：`${baseUrl}/chat/completions`，默认 https://api.deepseek.com
 * - 认证：Authorization: Bearer ${DEEPSEEK_API_KEY}（只从环境变量读取，绝不写进仓库）
 * - 结构化输出：jsonMode 时传 response_format = { type: 'json_object' }
 *
 * 未核实项：本仓库交付时若没有可用密钥，则**没有执行过**真实调用，
 * 模型名与路由仅按官方文档配置，属于「未验证配置」。见 reports/DEEPSEEK_EVALUATION.md。
 */

import type { LLMMessage, LLMProvider, LLMRequest, LLMResponse } from '../../types.ts'

export interface DeepSeekProviderOptions {
  apiKey: string
  baseUrl?: string
  model?: string
  timeoutMs?: number
  /** 允许注入 fetch，便于测试时替换成假网络层 */
  fetchImpl?: typeof fetch
}

export class ProviderError extends Error {
  readonly status: number | null
  constructor(message: string, status: number | null = null, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ProviderError'
    this.status = status
  }
}

export class DeepSeekProvider implements LLMProvider {
  readonly name = 'deepseek'
  readonly model: string
  #apiKey: string
  #baseUrl: string
  #timeoutMs: number
  #fetch: typeof fetch

  constructor(opts: DeepSeekProviderOptions) {
    if (!opts.apiKey || opts.apiKey.trim().length === 0) {
      throw new ProviderError('缺少 DeepSeek API Key（请设置环境变量 DEEPSEEK_API_KEY）')
    }
    this.#apiKey = opts.apiKey
    this.#baseUrl = (opts.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '')
    this.model = opts.model ?? 'deepseek-chat'
    this.#timeoutMs = opts.timeoutMs ?? 60_000
    this.#fetch = opts.fetchImpl ?? fetch
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: request.system },
      ...request.messages,
    ]
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: request.temperature,
      max_tokens: request.maxTokens,
      stream: false,
    }
    if (request.jsonMode) {
      body.response_format = { type: 'json_object' }
    }

    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs)
    let response: Response
    try {
      response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.#apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      throw new ProviderError(`网络请求失败: ${(err as Error).message}`, null, { cause: err })
    } finally {
      clearTimeout(timer)
    }

    const raw = await response.text()
    if (!response.ok) {
      // 注意：错误体里可能包含请求回显，这里只保留前 400 字符，且不记录 Key。
      throw new ProviderError(
        `DeepSeek 返回 HTTP ${response.status}: ${raw.slice(0, 400)}`,
        response.status,
      )
    }

    let parsed: {
      choices?: Array<{ message?: { content?: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
      model?: string
    }
    try {
      parsed = JSON.parse(raw) as typeof parsed
    } catch (err) {
      throw new ProviderError('DeepSeek 响应不是合法 JSON', response.status, { cause: err })
    }

    const text = parsed.choices?.[0]?.message?.content
    if (typeof text !== 'string') {
      throw new ProviderError('DeepSeek 响应缺少 choices[0].message.content', response.status)
    }

    return {
      text,
      provider: this.name,
      model: parsed.model ?? this.model,
      usage: parsed.usage
        ? {
            promptTokens: parsed.usage.prompt_tokens ?? 0,
            completionTokens: parsed.usage.completion_tokens ?? 0,
          }
        : null,
      latencyMs: Date.now() - started,
    }
  }
}

export function hasDeepSeekCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return typeof env.DEEPSEEK_API_KEY === 'string' && env.DEEPSEEK_API_KEY.trim().length > 0
}

export function deepSeekConfigFromEnv(env: NodeJS.ProcessEnv = process.env): {
  apiKey: string
  baseUrl: string
  model: string
} | null {
  if (!hasDeepSeekCredentials(env)) return null
  return {
    apiKey: env.DEEPSEEK_API_KEY!.trim(),
    baseUrl: env.DEEPSEEK_BASE_URL?.trim() || 'https://api.deepseek.com',
    model: env.DEEPSEEK_MODEL?.trim() || 'deepseek-chat',
  }
}
