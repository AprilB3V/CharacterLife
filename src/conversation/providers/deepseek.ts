/**
 * OpenAI-compatible provider (historically named DeepSeekProvider) —— 真实模型接入。
 *
 * Works with any `/chat/completions` endpoint: DeepSeek, OpenAI, OpenRouter, Volcengine Ark,
 * and local servers such as Ollama or LM Studio. Local endpoints may omit the API key.
 *
 * 只依赖 Node 内置 fetch，不引入 SDK：
 * - 路由：`${baseUrl}/chat/completions`，默认 https://api.deepseek.com
 * - 认证：Authorization: Bearer ${DEEPSEEK_API_KEY}（只从环境变量读取，绝不写进仓库）
 * - 结构化输出：jsonMode 时传 response_format = { type: 'json_object' }
 *
 * 未核实项：本仓库交付时若没有可用密钥，则**没有执行过**真实调用，
 * 模型名与路由仅按官方文档配置，属于「未验证配置」。见 reports/DEEPSEEK_EVALUATION.md。
 */

import type { LLMProvider, LLMRequest, LLMResponse } from '../../types.ts'
import { parseReasoningMode, resolveReasoningMode } from './reasoning.ts'
import type { ReasoningMode } from './reasoning.ts'

export interface DeepSeekProviderOptions {
  /** Required unless baseUrl points at a local host (localhost, 127.0.0.1, ::1, *.localhost). */
  apiKey?: string
  baseUrl?: string
  model?: string
  timeoutMs?: number
  /** 允许注入 fetch，便于测试时替换成假网络层 */
  fetchImpl?: typeof fetch
  /** Extra request-body fields for compatible endpoints (e.g. `{ thinking: { type: 'disabled' } }`). */
  extraBody?: Record<string, unknown>
}

export class ProviderError extends Error {
  readonly status: number | null
  constructor(message: string, status: number | null = null, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ProviderError'
    this.status = status
  }
}

/** Reasoning text kept per call for the console trace; the full length is still counted. */
const REASONING_TEXT_CAP = 20_000

export class DeepSeekProvider implements LLMProvider {
  readonly name = 'deepseek'
  readonly model: string
  #apiKey: string
  #baseUrl: string
  #timeoutMs: number
  #fetch: typeof fetch
  #extraBody: Record<string, unknown>

  constructor(opts: DeepSeekProviderOptions) {
    this.#baseUrl = (opts.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '')
    this.#apiKey = opts.apiKey?.trim() ?? ''
    if (!this.#apiKey && !isLocalBaseUrl(this.#baseUrl)) {
      throw new ProviderError('Missing API key (set CHARACTERLIFE_MODEL_API_KEY); only local endpoints may omit it')
    }
    this.model = opts.model ?? 'deepseek-chat'
    this.#timeoutMs = opts.timeoutMs ?? 60_000
    this.#fetch = opts.fetchImpl ?? fetch
    this.#extraBody = opts.extraBody ?? {}
  }

  /** Non-secret settings for the owner console (never the key). */
  describe(): Record<string, unknown> {
    // Only known, non-secret request options are shown; anything else in the body is listed by name.
    const { thinking, reasoning_effort: reasoningEffort, ...rest } = this.#extraBody
    return {
      baseUrl: this.#baseUrl,
      timeoutMs: this.#timeoutMs,
      ...(thinking !== undefined ? { thinking: JSON.stringify(thinking) } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort: String(reasoningEffort) } : {}),
      ...(Object.keys(rest).length ? { otherBodyFields: Object.keys(rest).join(', ') } : {}),
    }
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: request.system },
      ...request.messages,
    ]
    const body: Record<string, unknown> = {
      ...this.#extraBody,
      model: this.model,
      messages,
      temperature: request.temperature,
      stream: Boolean(request.onTextDelta),
    }
    // maxTokens <= 0 sends no max_tokens, leaving the API's own limit.
    if (request.maxTokens > 0) body.max_tokens = request.maxTokens
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
          ...(this.#apiKey ? { Authorization: `Bearer ${this.#apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimeout(timer)
      throw new ProviderError(`网络请求失败: ${(err as Error).message}`, null, { cause: err })
    }

    try {
    if (response.ok && String(response.headers.get('content-type')).includes('event-stream')) {
        return await this.#consumeStream(response, request, started)
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
      choices?: Array<{ message?: { content?: string; reasoning_content?: string; reasoning?: string }; finish_reason?: string }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
      model?: string
    }
    try {
      parsed = JSON.parse(raw) as typeof parsed
    } catch (err) {
      throw new ProviderError('DeepSeek 响应不是合法 JSON', response.status, { cause: err })
    }

    const choice = parsed.choices?.[0]
    const text = choice?.message?.content
    // DeepSeek returns reasoning_content; Ollama returns reasoning.
    const rawReasoning = choice?.message?.reasoning_content ?? choice?.message?.reasoning
    const messageReasoning = typeof rawReasoning === 'string' ? rawReasoning : ''
    if (typeof text !== 'string') {
      throw new ProviderError('DeepSeek 响应缺少 choices[0].message.content', response.status)
    }

    request.onTextDelta?.(text)
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
      finishReason: choice?.finish_reason ?? null,
      reasoningChars: messageReasoning.length,
      ...(messageReasoning ? { reasoningText: messageReasoning.slice(0, REASONING_TEXT_CAP) } : {}),
    }
    } finally { clearTimeout(timer) }
  }

  async #consumeStream(response: Response, request: LLMRequest, started: number): Promise<LLMResponse> {
    if (!response.body) throw new ProviderError('Model stream is empty')
    const decoder = new TextDecoder()
    let buffer = ''
    let text = ''
    let model = this.model
    let usage: LLMResponse['usage'] = null
    let finishReason: string | null = null
    let reasoningChars = 0
    let reasoningText = ''
    let completed = false
    const handleLine = (line: string) => {
        if (!line.startsWith('data:')) return
        const raw = line.slice(5).trim()
        if (!raw) return
        if (raw === '[DONE]') { completed = true; return }
        const event = JSON.parse(raw)
        if (event.error) throw new ProviderError('Model stream returned an error')
        if (event.model) model = event.model
        const choice = event.choices?.[0]
        const content = choice?.delta?.content
        if (typeof content === 'string' && content) {
            text += content
            request.onTextDelta?.(content)
        }
        // DeepSeek streams reasoning_content; Ollama streams reasoning.
        const reasoning = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning
        if (typeof reasoning === 'string' && reasoning) {
            reasoningChars += reasoning.length
            if (reasoningText.length < REASONING_TEXT_CAP) reasoningText += reasoning.slice(0, REASONING_TEXT_CAP - reasoningText.length)
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason
        if (event.usage) usage = { promptTokens: event.usage.prompt_tokens ?? 0, completionTokens: event.usage.completion_tokens ?? 0 }
    }
    for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true })
        let newline
        while ((newline = buffer.indexOf('\n')) >= 0) {
            handleLine(buffer.slice(0, newline).replace(/\r$/, ''))
            buffer = buffer.slice(newline + 1)
        }
    }
    buffer += decoder.decode()
    if (buffer.trim()) handleLine(buffer.trim())
    if (!completed && !finishReason) throw new ProviderError('Model stream ended before completion')
    return { text, provider: this.name, model, usage, finishReason, reasoningChars,
        ...(reasoningText ? { reasoningText } : {}), latencyMs: Date.now() - started }
  }
}

/** True for endpoints on this machine, which may run without an API key (Ollama, LM Studio). */
export function isLocalBaseUrl(baseUrl: string | undefined | null): boolean {
  if (!baseUrl) return false
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost')
  } catch {
    return false
  }
}

/** CHARACTERLIFE_MODEL_* wins; the older DEEPSEEK_* names keep working. */
function readModelEnv(env: NodeJS.ProcessEnv): { apiKey: string; baseUrl: string; model: string } {
  const pick = (name: string) => (env[`CHARACTERLIFE_MODEL_${name}`]?.trim() || env[`DEEPSEEK_${name}`]?.trim() || '')
  return { apiKey: pick('API_KEY'), baseUrl: pick('BASE_URL'), model: pick('MODEL') }
}

/** A real model is configured: an API key, or a local base URL that needs none. */
export function hasDeepSeekCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  const { apiKey, baseUrl } = readModelEnv(env)
  return apiKey.length > 0 || isLocalBaseUrl(baseUrl)
}

export function deepSeekConfigFromEnv(env: NodeJS.ProcessEnv = process.env): {
  apiKey: string
  baseUrl: string
  model: string
  /** CHARACTERLIFE_REASONING, else the verified default for the model (see reasoning.ts) */
  reasoning: ReasoningMode
} | null {
  if (!hasDeepSeekCredentials(env)) return null
  const raw = readModelEnv(env)
  const model = raw.model || 'deepseek-chat'
  return {
    apiKey: raw.apiKey,
    baseUrl: raw.baseUrl || 'https://api.deepseek.com',
    model,
    reasoning: resolveReasoningMode(model, parseReasoningMode(env.CHARACTERLIFE_REASONING)),
  }
}

/** Neutral names for the same provider; the DeepSeek-prefixed names stay for compatibility. */
export {
  DeepSeekProvider as OpenAICompatibleProvider,
  hasDeepSeekCredentials as hasModelConfig,
  deepSeekConfigFromEnv as modelConfigFromEnv,
}
