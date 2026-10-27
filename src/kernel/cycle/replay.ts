/**
 * 录制与回放 Provider（V0.4）。
 *
 * 自主运行要调用模型，DECISIONS.md 担心的是「不可复现」。解决办法不是不调用，
 * 而是把每一次调用录下来：
 *   - RecordingProvider 包住真实 Provider，记录 (请求指纹, 响应)；
 *   - ReplayProvider 按顺序吐出录好的响应，并校验请求指纹一致。
 *
 * 指纹不一致说明「同一个种子下，模型看到的输入变了」——代码或数据有改动，
 * 回放会明确失败而不是悄悄给出不同的结果。
 */

import { createHash } from 'node:crypto'
import type { LLMProvider, LLMRequest, LLMResponse } from '../types.ts'

export interface RecordedCall {
  index: number
  fingerprint: string
  request: { system: string; messages: LLMRequest['messages']; temperature: number; maxTokens: number }
  response: LLMResponse
}

export function fingerprintRequest(request: LLMRequest): string {
  return createHash('sha256')
    .update(JSON.stringify({ s: request.system, m: request.messages, t: request.temperature, k: request.maxTokens }))
    .digest('hex')
    .slice(0, 16)
}

export class RecordingProvider implements LLMProvider {
  readonly calls: RecordedCall[] = []
  #inner: LLMProvider

  constructor(inner: LLMProvider) {
    this.#inner = inner
  }

  get name(): string {
    return this.#inner.name
  }

  get model(): string {
    return this.#inner.model
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const response = await this.#inner.complete(request)
    this.calls.push({
      index: this.calls.length,
      fingerprint: fingerprintRequest(request),
      request: {
        system: request.system,
        messages: request.messages.map((m) => ({ ...m })),
        temperature: request.temperature,
        maxTokens: request.maxTokens,
      },
      response: { ...response },
    })
    return response
  }
}

export class ReplayMismatchError extends Error {
  constructor(index: number, expected: string, actual: string) {
    super(`回放第 ${index} 次调用时请求指纹不一致：录制 ${expected}，本次 ${actual}（输入已变化，结果不可复现）`)
    this.name = 'ReplayMismatchError'
  }
}

export class ReplayProvider implements LLMProvider {
  readonly name: string
  readonly model: string
  #calls: readonly RecordedCall[]
  #next = 0
  #strict: boolean

  constructor(calls: readonly RecordedCall[], opts: { strict?: boolean } = {}) {
    this.#calls = calls
    this.#strict = opts.strict ?? true
    this.name = `replay:${calls[0]?.response.provider ?? 'empty'}`
    this.model = calls[0]?.response.model ?? 'replay'
  }

  get consumed(): number {
    return this.#next
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const call = this.#calls[this.#next]
    if (!call) throw new Error(`回放用尽：录制里只有 ${this.#calls.length} 次调用`)
    const actual = fingerprintRequest(request)
    if (this.#strict && actual !== call.fingerprint) {
      throw new ReplayMismatchError(this.#next, call.fingerprint, actual)
    }
    this.#next += 1
    return { ...call.response, latencyMs: 0 }
  }
}
