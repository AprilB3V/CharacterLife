import test from 'node:test'
import assert from 'node:assert/strict'
import { assembleRuntime } from '../src/api/runtime-factory.ts'
import { createConsoleServer } from '../src/console/server.ts'
import { DeepSeekProvider } from '../src/conversation/providers/deepseek.ts'
import { TraceStore } from '../src/runtime/trace.ts'
import type { TurnTrace } from '../src/runtime/trace.ts'
import type { LLMProvider, LLMRequest, LLMResponse } from '../src/types.ts'

class Scripted implements LLMProvider {
    readonly name = 'scripted'
    readonly model = 'scripted-1'
    #outputs: Array<Partial<LLMResponse> & { text: string }>
    #calls = 0
    constructor(outputs: Array<Partial<LLMResponse> & { text: string }>) { this.#outputs = outputs }
    async complete(_request: LLMRequest): Promise<LLMResponse> {
        const output = this.#outputs[Math.min(this.#calls++, this.#outputs.length - 1)]!
        return { provider: this.name, model: this.model, usage: { promptTokens: 10, completionTokens: 5 }, latencyMs: 3, finishReason: 'stop', ...output }
    }
}

const GOOD = JSON.stringify({
    reply: '行，记下了。',
    proposals: [],
    memoryWrites: [{ kind: 'user', title: '喜欢猫', content: '用户说自己喜欢猫', status: 'fact' }],
})

async function oneTurn(outputs: Array<Partial<LLMResponse> & { text: string }>, extra: Parameters<typeof assembleRuntime>[0] extends infer C ? Partial<C> : never = {}) {
    const runtime = assembleRuntime({ dbPath: ':memory:', worldId: 'world_test', provider: new Scripted(outputs), auditFile: null, ...extra })
    const identity = runtime.identityService.resolveOrCreate('sillytavern', 'user', '用户')
    const instance = runtime.runtimeManager.get(identity.instance.id)
    const result = await runtime.runtimeManager.send(instance, { identityKey: 'sillytavern:user', text: '我喜欢猫' })
    return { runtime, instanceId: identity.instance.id, result }
}

test('a turn leaves a full trace: input, decision, prompt, attempt with reasoning, envelope and memory result', async () => {
    const { runtime, instanceId, result } = await oneTurn([{ text: GOOD, reasoningText: '先想想她会怎么接', reasoningChars: 8 }])
    try {
        const traces = runtime.traces!.list(instanceId)
        assert.equal(traces.length, 1)
        const trace = traces[0] as TurnTrace
        assert.equal(trace.kind, 'turn')
        assert.equal(trace.identityKey, 'sillytavern:user')
        assert.equal(trace.input, '我喜欢猫')
        assert.ok(trace.turnId.startsWith('turn_'))
        assert.ok(trace.decision?.action)
        assert.ok(trace.prompt?.system.length, 'the system prompt is captured')
        assert.equal(trace.attempts.length, 1)
        assert.equal(trace.attempts[0]!.reasoning, '先想想她会怎么接')
        assert.equal(trace.attempts[0]!.parseError, null)
        assert.equal(trace.envelope?.reply, '行，记下了。')
        assert.equal(trace.outcome?.reply, result.reply)
        assert.equal(trace.outcome?.fallback, null)
        assert.deepEqual(trace.outcome?.memories.map(m => m.result), ['written'])
    } finally { runtime.close() }
})

test('a broken envelope shows both attempts and the fallback reason', async () => {
    const { runtime, instanceId, result } = await oneTurn([{ text: '{"type":"json_object"}' }, { text: '{"reply": "不认', finishReason: 'length' }])
    try {
        const trace = runtime.traces!.list(instanceId)[0] as TurnTrace
        assert.equal(result.reply, '刚才的回复没有完整生成，你再说一次？')
        assert.equal(trace.attempts.length, 2)
        assert.equal(trace.attempts[0]!.raw, '{"type":"json_object"}')
        assert.ok(trace.attempts[1]!.parseError)
        assert.equal(trace.envelope, null)
        assert.equal(trace.outcome?.fallback, 'broken_envelope')
    } finally { runtime.close() }
})

test('held memories are traced as held, and tracing can be turned off', async () => {
    const held = await oneTurn([{ text: GOOD }], { memoryReview: 'model' })
    try {
        const trace = held.runtime.traces!.list(held.instanceId)[0] as TurnTrace
        assert.deepEqual(trace.outcome?.memories.map(m => m.result), ['held'])
    } finally { held.runtime.close() }
    const off = await oneTurn([{ text: GOOD }], { tracesPerInstance: 0 })
    try {
        assert.equal(off.runtime.traces, null)
        assert.equal(off.result.reply, '行，记下了。', 'turns behave the same without a trace sink')
    } finally { off.runtime.close() }
})

test('the trace store keeps only the newest traces per instance, newest first', () => {
    const store = new TraceStore({ perInstance: 2 })
    for (const n of [1, 2, 3]) {
        store.record({ kind: 'think', id: store.nextId('trc'), instanceId: 'a', atWall: '', identityKey: 'k', inputs: [], steps: [],
            thought: { decision: String(n) } as never, silent: false })
    }
    const list = store.list('a')
    assert.deepEqual(list.map(t => t.kind === 'think' && t.thought.decision), ['3', '2'])
    assert.equal(store.list('b').length, 0)
})

test('runtime description reports settings without secrets', () => {
    const provider = new DeepSeekProvider({ apiKey: 'sk-secret-should-not-leak', baseUrl: 'https://example.invalid/v1', model: 'm1' })
    const runtime = assembleRuntime({ dbPath: ':memory:', worldId: 'world_test', provider, auditFile: null, thinkProvider: null,
        onebot: { baseUrl: 'http://127.0.0.1:3000', accessToken: 'onebot-token-should-not-leak' },
        telegram: { token: '123:telegram-token-should-not-leak' } })
    try {
        const description = runtime.describe()
        const text = JSON.stringify(description)
        for (const secret of ['sk-secret-should-not-leak', 'onebot-token-should-not-leak', 'telegram-token-should-not-leak']) {
            assert.ok(!text.includes(secret), `${secret} must not appear`)
        }
        assert.equal(description.provider.model, 'm1')
        assert.equal(description.provider.settings.baseUrl, 'https://example.invalid/v1')
        assert.equal(description.adapters.onebot!.accessToken, 'set')
        assert.equal(description.conversation.maxTokens, 2000)
        assert.equal(description.template.id, runtime.template.id)
    } finally { runtime.close() }
})

test('console serves traces and config behind the token', async () => {
    const { runtime, instanceId } = await oneTurn([{ text: GOOD }])
    const token = 'console-token-1234567890'
    const handle = createConsoleServer({ runtime, token, port: 0 })
    const { url } = await handle.listen()
    try {
        const get = (path: string, auth = true) => fetch(`${url}/api${path}`, { headers: auth ? { authorization: `Bearer ${token}` } : {} })
        assert.equal((await get('/config', false)).status, 401)
        const config = await (await get('/config')).json() as { template: { id: string } }
        assert.equal(config.template.id, runtime.template.id)
        const body = await (await get(`/instances/${instanceId}/traces?kind=turn`)).json() as { enabled: boolean; traces: TurnTrace[] }
        assert.equal(body.enabled, true)
        assert.equal(body.traces.length, 1)
        assert.equal(body.traces[0]!.input, '我喜欢猫')
        assert.equal((await get(`/instances/${instanceId}/traces?kind=bad`)).status, 400)
        const inst = await (await get(`/instances/${instanceId}/instance-config`)).json() as { record: { id: string } }
        assert.equal(inst.record.id, instanceId)
        const asset = await fetch(`${url}/trace.js`)
        assert.equal(asset.status, 200)
    } finally {
        await handle.close()
        runtime.close()
    }
})

test('a thinking-loop run is traced with its steps and the rule ruling', async () => {
    const thinker: LLMProvider = {
        name: 'think', model: 'think-1',
        async complete() {
            return { text: JSON.stringify({ heard: '你好', meant: '打招呼', meantConf: 0.9, turn: 'asking_me', decision: 'reply', emotion: 'neutral',
                innerOS: '有人来了' }), provider: 'think', model: 'think-1', usage: null, latencyMs: 1 }
        },
    }
    const runtime = assembleRuntime({ dbPath: ':memory:', worldId: 'world_test', provider: new Scripted([{ text: GOOD }]), thinkProvider: thinker, auditFile: null })
    try {
        const identity = runtime.identityService.resolveOrCreate('sillytavern', 'host')
        const instance = runtime.runtimeManager.get(identity.instance.id)
        await runtime.runtimeManager.think(instance, { identityKey: 'sillytavern:host', inputs: [{ kind: 'speech', text: '你好' } as never] })
        const [trace] = runtime.traces!.list(identity.instance.id, { kind: 'think' })
        assert.ok(trace && trace.kind === 'think')
        assert.equal(trace.steps.length, 1)
        assert.equal(trace.steps[0]!.draft.innerOS, '有人来了')
        assert.equal(trace.thought.proposed, 'reply')
        assert.ok(trace.thought.ruling)
    } finally { runtime.close() }
})

test('review fixes: a non-string reasoning field is ignored instead of failing a valid reply', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
        choices: [{ message: { content: GOOD, reasoning_content: { odd: true } }, finish_reason: 'stop' }],
    }), { status: 200 })) as unknown as typeof fetch
    const provider = new DeepSeekProvider({ apiKey: 'k', fetchImpl })
    const response = await provider.complete({ system: 's', messages: [], temperature: 0, maxTokens: 10, jsonMode: true })
    assert.equal(response.text, GOOD)
    assert.equal(response.reasoningText, undefined)
})

test('review fixes: provider settings and URLs are redacted, token counts are kept', () => {
    const provider: LLMProvider = {
        name: 'custom', model: 'c1',
        async complete() { throw new Error('unused') },
        describe: () => ({ apiKey: 'leak-1', endpoint: 'https://user:leak-2@host.invalid/v1?api_key=leak-3&region=cn', maxTokens: 512, n: 10n }),
    }
    const runtime = assembleRuntime({ dbPath: ':memory:', worldId: 'world_test', provider, auditFile: null, thinkProvider: null,
        onebot: { baseUrl: 'http://admin:leak-4@127.0.0.1:3000/?access_token=leak-5' } })
    try {
        const text = JSON.stringify(runtime.describe())
        for (const secret of ['leak-1', 'leak-2', 'leak-3', 'leak-4', 'leak-5']) assert.ok(!text.includes(secret), secret)
        const settings = runtime.describe().provider.settings
        assert.equal(settings.maxTokens, 512)
        assert.equal(settings.n, '10')
        assert.match(String(settings.endpoint), /region=cn/)
    } finally { runtime.close() }
})

test('review fixes: recorded traces are detached and bounded', () => {
    const store = new TraceStore({ perInstance: 5, maxInstances: 2 })
    const thought = { decision: 'reply', innerOS: 'x'.repeat(50_000), fn: () => 1 } as never
    const inputs = [{ kind: 'speech', text: '你好' }]
    store.record({ kind: 'think', id: 't1', instanceId: 'a', atWall: '', identityKey: 'k', inputs: inputs as never, steps: [], thought, silent: false })
    inputs[0]!.text = '改过了'
    const [saved] = store.list('a')
    assert.ok(saved && saved.kind === 'think')
    assert.equal(saved.inputs[0]!.text, '你好')
    assert.ok(String((saved.thought as { innerOS: string }).innerOS).length < 21_000)
    for (const id of ['b', 'c']) store.record({ ...saved, instanceId: id })
    assert.equal(store.has('a'), false, 'the least recently traced instance is dropped')
})

test('review fixes: a failed model call is still listed as an attempt', async () => {
    const failing: LLMProvider = { name: 'down', model: 'down-1', async complete() { throw new Error('upstream 503') } }
    const runtime = assembleRuntime({ dbPath: ':memory:', worldId: 'world_test', provider: failing, auditFile: null })
    try {
        const identity = runtime.identityService.resolveOrCreate('sillytavern', 'user')
        const instance = runtime.runtimeManager.get(identity.instance.id)
        await runtime.runtimeManager.send(instance, { identityKey: 'sillytavern:user', text: '在吗' })
        const trace = runtime.traces!.list(identity.instance.id)[0] as TurnTrace
        assert.equal(trace.outcome?.fallback, 'provider_error')
        assert.equal(trace.attempts.length, 1)
        assert.match(trace.attempts[0]!.parseError ?? '', /upstream 503/)
    } finally { runtime.close() }
})

test('review fixes: trace endpoint validates instance, limit and token', async () => {
    const { runtime, instanceId } = await oneTurn([{ text: GOOD }])
    const token = 'console-token-1234567890'
    const handle = createConsoleServer({ runtime, token, port: 0 })
    const { url } = await handle.listen()
    try {
        const get = (path: string, auth = true) => fetch(`${url}/api${path}`, { headers: auth ? { authorization: `Bearer ${token}` } : {} })
        assert.equal((await get(`/instances/${instanceId}/traces`, false)).status, 401)
        assert.equal((await get('/instances/inst_missing/traces')).status, 404)
        assert.equal((await get(`/instances/${instanceId}/traces?limit=0`)).status, 400)
    } finally {
        await handle.close()
        runtime.close()
    }
})

test('review fixes: tracing on or off leaves the same reply, history, memories and audit', async () => {
    const outputs = [{ text: '{"type":"json_object"}' }, { text: GOOD }]
    const snapshot = async (tracesPerInstance: number) => {
        const { runtime, instanceId, result } = await oneTurn(outputs.map(o => ({ ...o })), { tracesPerInstance })
        try {
            const rt = runtime.runtimeManager.get(instanceId)
            return {
                reply: result.reply,
                history: rt.histories.get('sillytavern:user'),
                memories: rt.workspace.memory.list({ limit: 100 }).map(m => [m.kind, m.title, m.status, m.trust]),
                audit: rt.workspace.audit.tail(100).map(e => [e.type, e.summary]),
            }
        } finally { runtime.close() }
    }
    assert.deepEqual(await snapshot(100), await snapshot(0))
})
