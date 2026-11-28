/**
 * A provider whose backing model can be swapped at runtime (owner console "模型接入").
 *
 * Every consumer holds this one object, so a swap takes effect on the next call without a
 * restart. A call already in flight finishes on the provider it started with.
 */

import type { LLMProvider, LLMRequest, LLMResponse } from '../../types.ts'

export class SwitchableProvider implements LLMProvider {
    #inner: LLMProvider
    #note: string
    #source: string

    constructor(inner: LLMProvider, note: string, source = 'startup') {
        this.#inner = inner
        this.#note = note
        this.#source = source
    }

    get name(): string { return this.#inner.name }
    get model(): string { return this.#inner.model }
    /** Human-readable origin of the current model, e.g. "后台配置「Gemini」". */
    get note(): string { return this.#note }
    /** Machine-readable origin: 'explicit' | 'env' | 'mock' | 'console:<profileId>'. */
    get source(): string { return this.#source }
    get inner(): LLMProvider { return this.#inner }

    complete(request: LLMRequest): Promise<LLMResponse> {
        return this.#inner.complete(request)
    }

    describe(): Record<string, unknown> {
        return this.#inner.describe?.() ?? {}
    }

    swap(inner: LLMProvider, note: string, source: string): void {
        if (inner === this) throw new Error('A switchable provider cannot wrap itself')
        this.#inner = inner
        this.#note = note
        this.#source = source
    }
}
