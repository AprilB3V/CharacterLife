import test from 'node:test'
import assert from 'node:assert/strict'
import { assembleRuntime } from '../src/api/runtime-factory.ts'
import { DeepSeekProvider } from '../src/conversation/providers/deepseek.ts'
import type { LLMProvider, LLMRequest, LLMResponse } from '../src/types.ts'

/** Returns the scripted outputs in order, streaming each one when asked to. */
type Output = string | { text: string; finishReason: string }

class Scripted implements LLMProvider {
    readonly name = 'scripted'
    readonly model = 'scripted'
    calls = 0
    #outputs: Output[]
    #stream: boolean
    constructor(outputs: Output[], stream: boolean) { this.#outputs = outputs; this.#stream = stream }
    async complete(request: LLMRequest): Promise<LLMResponse> {
        const output = this.#outputs[Math.min(this.calls++, this.#outputs.length - 1)]!
        const { text, finishReason } = typeof output === 'string' ? { text: output, finishReason: 'stop' } : output
        if (this.#stream) for (const character of text) request.onTextDelta?.(character)
        return { text, provider: this.name, model: this.model, usage: null, latencyMs: 0, finishReason }
    }
}

async function turn(outputs: Output[], stream = true) {
    const provider = new Scripted(outputs, stream)
    const runtime = assembleRuntime({ dbPath: ':memory:', worldId: 'world_test', provider })
    try {
        const identity = runtime.identityService.resolveOrCreate('sillytavern', 'user', '用户')
        const instance = runtime.runtimeManager.get(identity.instance.id)
        let shown = ''
        const onReplyDelta = stream ? (delta: string) => { shown += delta } : undefined
        const result = await runtime.runtimeManager.send(instance, { identityKey: 'user', text: '开始吧', onReplyDelta })
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

// M0 baseline 2026-11-17: without streaming, `{}` and truncated JSON reached the user verbatim.
test('non-streaming: an empty object twice degrades instead of showing "{}"', async () => {
    const { result, calls, audit } = await turn(['{}', '{}'], false)
    assert.equal(calls, 2)
    assert.equal(result.reply, '刚才的回复没有完整生成，你再说一次？')
    assert.ok(audit.some(e => e.summary === '结构化输出不完整，已使用降级台词'))
})

test('non-streaming: output cut at the length limit is retried, then degrades', async () => {
    const cut = { text: '{"reply":"同事那句「别往心里去」，我不太', finishReason: 'length' }
    const recovered = await turn([cut, GOOD], false)
    assert.equal(recovered.calls, 2)
    assert.equal(recovered.result.reply, '行，开吧。')
    const failed = await turn([cut, cut], false)
    assert.equal(failed.result.reply, '刚才的回复没有完整生成，你再说一次？')
})

test('non-streaming: a dangling code fence is not shown raw', async () => {
    const { result } = await turn(['```json\n{"reply":"半截', '```json\n{"reply":"半截'], false)
    assert.equal(result.reply, '刚才的回复没有完整生成，你再说一次？')
})

test('plain prose without JSON is still shown as the reply', async () => {
    const { result, calls } = await turn(['在。手上正在给一本书换书脊。'], false)
    assert.equal(calls, 1)
    assert.equal(result.reply, '在。手上正在给一本书换书脊。')
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

test('default completion cap leaves room for reasoning models', async () => {
    let seen = -1
    const provider: LLMProvider = {
        name: 'capture',
        model: 'capture',
        async complete(request) {
            seen = request.maxTokens
            return { text: GOOD, provider: 'capture', model: 'capture', usage: null, latencyMs: 0, finishReason: 'stop' }
        },
    }
    const runtime = assembleRuntime({ dbPath: ':memory:', worldId: 'world_test', provider })
    try {
        const identity = runtime.identityService.resolveOrCreate('sillytavern', 'user', '用户')
        await runtime.runtimeManager.send(runtime.runtimeManager.get(identity.instance.id), { identityKey: 'user', text: '开始吧' })
    } finally { runtime.close() }
    assert.equal(seen, 2000)
})
