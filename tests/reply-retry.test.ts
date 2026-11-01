import test from 'node:test'
import assert from 'node:assert/strict'
import { assembleRuntime } from '../src/api/runtime-factory.ts'
import { DeepSeekProvider } from '../src/conversation/providers/deepseek.ts'
import type { LLMProvider, LLMRequest, LLMResponse } from '../src/types.ts'

/** Returns the scripted outputs in order, streaming each one when asked to. */
class Scripted implements LLMProvider {
    readonly name = 'scripted'
    readonly model = 'scripted'
    calls = 0
    #outputs: string[]
    constructor(outputs: string[]) { this.#outputs = outputs }
    async complete(request: LLMRequest): Promise<LLMResponse> {
        const text = this.#outputs[Math.min(this.calls++, this.#outputs.length - 1)]!
        for (const character of text) request.onTextDelta?.(character)
        return { text, provider: this.name, model: this.model, usage: null, latencyMs: 0, finishReason: 'stop' }
    }
}

async function turn(outputs: string[]) {
    const provider = new Scripted(outputs)
    const runtime = assembleRuntime({ dbPath: ':memory:', worldId: 'world_test', provider })
    try {
        const identity = runtime.identityService.resolveOrCreate('sillytavern', 'user', '用户')
        const instance = runtime.runtimeManager.get(identity.instance.id)
        let shown = ''
        const result = await runtime.runtimeManager.send(instance, { identityKey: 'user', text: '开始吧', onReplyDelta: delta => { shown += delta } })
        return { result, shown, calls: provider.calls, audit: instance.workspace.audit.filter('provider_error') }
    } finally { runtime.close() }
}

const GOOD = JSON.stringify({ reply: '行，开吧。', proposals: [], memoryWrites: [] })

test('a structured output without reply is retried once before anything is shown', async () => {
    const { result, shown, calls, audit } = await turn(['{"type":"json_object"}', GOOD])
    assert.equal(calls, 2)
    assert.equal(result.reply, '行，开吧。')
    assert.equal(shown, '行，开吧。')
    assert.equal(audit[0]!.data.raw, '{"type":"json_object"}', 'the raw output is kept for diagnosis')
})

test('a second failure still degrades to the existing apology, without a third call', async () => {
    const { result, calls } = await turn(['{"type":"json_object"}', '{"other":1}'])
    assert.equal(calls, 2)
    assert.equal(result.reply, '刚才的回复没有完整生成，你再说一次？')
})

test('valid output is not retried', async () => {
    const { calls } = await turn([GOOD])
    assert.equal(calls, 1)
})

test('maxTokens 0 sends no max_tokens to the model API', async () => {
    const bodies: Array<Record<string, unknown>> = []
    const provider = new DeepSeekProvider({ apiKey: 'test-only', fetchImpl: async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)))
        return new Response(JSON.stringify({ choices: [{ message: { content: GOOD }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    } })
    await provider.complete({ system: 's', messages: [], temperature: 0, maxTokens: 0, jsonMode: true })
    await provider.complete({ system: 's', messages: [], temperature: 0, maxTokens: 300, jsonMode: true })
    assert.ok(!('max_tokens' in bodies[0]!))
    assert.equal(bodies[1]!.max_tokens, 300)
})
