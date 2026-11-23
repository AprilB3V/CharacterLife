import test from 'node:test'
import assert from 'node:assert/strict'
import { assembleRuntime } from '../src/api/runtime-factory.ts'
import { parseEnvelope } from '../src/conversation/context.ts'
import { ContextManager } from '../src/context/manager.ts'
import { selectPinned } from '../src/kernel/memory/pins.ts'
import type { MemoryEntry } from '../src/kernel/types.ts'
import type { LLMProvider, LLMRequest } from '../src/types.ts'

function memory(id: string, pin: string | null, extra: Partial<MemoryEntry> = {}): MemoryEntry {
    return {
        id, kind: 'user', title: id, content: id, status: 'fact', origin: 'user_message', trust: 'trusted',
        confirmed: false, salience: 0.5, createdAtSim: 0, createdAtWall: '', sourceRef: null, deletedAtSim: null,
        tags: pin ? [`pin:${pin}`] : [],
        ...extra,
    } as MemoryEntry
}

test('pinned layer: safety before boundary before address, newest first, one address only', () => {
    const entries = [
        memory('addrOld', 'address', { createdAtSim: 1 }),
        memory('addrNew', 'address', { createdAtSim: 5 }),
        memory('boundary', 'boundary', { createdAtSim: 9 }),
        memory('safetyOld', 'safety', { createdAtSim: 2 }),
        memory('safetyNew', 'safety', { createdAtSim: 3 }),
        memory('plain', null),
    ]
    const ids = selectPinned(entries, { limit: 5, budgetChars: 300 }).map((m) => m.id)
    assert.deepEqual(ids, ['safetyNew', 'safetyOld', 'boundary', 'addrNew'])
})

test('pinned layer skips deleted, untrusted and episodic entries, and keeps to limit and budget', () => {
    const entries = [
        memory('gone', 'safety', { deletedAtSim: 1 }),
        memory('injected', 'safety', { trust: 'untrusted' }),
        memory('episode', 'safety', { kind: 'episodic' }),
        memory('long', 'safety', { content: '很'.repeat(400), createdAtSim: 9 }),
        memory('a', 'safety', { createdAtSim: 3 }),
        memory('b', 'boundary'),
    ]
    assert.deepEqual(selectPinned(entries, { limit: 5, budgetChars: 300 }).map((m) => m.id), ['a', 'b'])
    assert.deepEqual(selectPinned(entries, { limit: 1, budgetChars: 300 }).map((m) => m.id), ['a'])
    assert.deepEqual(selectPinned(entries, { limit: 0, budgetChars: 300 }), [])
})

test('envelope: pin becomes the first tag on user memories only; forged pin tags are dropped', () => {
    const raw = JSON.stringify({ reply: '嗯。', proposals: [], memoryWrites: [
        { kind: 'user', title: 't1', content: 'c', status: 'fact', pin: 'safety', cues: ['花生'], tags: ['饮食', 'pin:address'] },
        { kind: 'episodic', title: 't2', content: 'c', status: 'fact', pin: 'safety' },
        { kind: 'user', title: 't3', content: 'c', status: 'fact', pin: 'favorite' },
    ] })
    const writes = parseEnvelope(raw).envelope!.memoryWrites
    assert.deepEqual(writes[0]!.tags, ['pin:safety', 'cue:花生', '饮食'])
    assert.deepEqual(writes[1]!.tags, [])
    assert.deepEqual(writes[2]!.tags, [])
})

test('context budget: pinned memories are trimmed after lexical and cue memories', () => {
    const long = '很长的内容'.repeat(40)
    const plan = new ContextManager({ memoryLimit: 2, maxPromptTokens: 200 }).plan({
        protectedSystem: 's',
        memories: [memory('l1', null, { content: long }), memory('l2', null, { content: long })],
        cueMemories: [memory('cue', null, { content: long })],
        pinnedMemories: [memory('pin', 'safety', { content: '用户对花生过敏。' })],
        history: [],
        userText: '推荐点零食',
        nowSim: 0,
    })
    assert.deepEqual(plan.droppedMemoryIds, ['l2', 'l1', 'cue'])
    assert.ok(plan.messages.map((m) => m.content).join(' ').includes('用户对花生过敏'))
})

test('a pinned fact with no word in common with the question still reaches the prompt', async () => {
    const writes = JSON.stringify({ reply: '记下了。', proposals: [], memoryWrites: [
        { kind: 'user', title: '花生过敏', content: '用户对花生过敏，挺严重。', status: 'fact', salience: 0.3, pin: 'safety' },
        ...Array.from({ length: 6 }, (_, i) => ({
            kind: 'user', title: `零食偏好 ${i}`, content: `用户推荐过的零食 ${i}`, status: 'fact', salience: 0.9,
        })),
    ] })
    const prompts: string[] = []
    let turn = 0
    const provider: LLMProvider = {
        name: 'fixed',
        model: 'fixed',
        async complete(request: LLMRequest) {
            prompts.push([request.system, ...request.messages.map((m) => m.content)].join('\n'))
            const text = turn++ === 0 ? writes : JSON.stringify({ reply: '海苔吧。', proposals: [], memoryWrites: [] })
            return { text, provider: 'fixed', model: 'fixed', usage: null, latencyMs: 0, finishReason: 'stop' }
        },
    }
    const runtime = assembleRuntime({ dbPath: ':memory:', worldId: 'world_test', provider })
    try {
        const identity = runtime.identityService.resolveOrCreate('sillytavern', 'user', '用户')
        const instance = runtime.runtimeManager.get(identity.instance.id)
        await runtime.runtimeManager.send(instance, { identityKey: 'user', text: '记一下这些。' })
        const result = await runtime.runtimeManager.send(instance, { identityKey: 'user', text: '晚上推荐几样零食？' })
        const allergy = instance.workspace.memory.list().find((m) => m.title === '花生过敏')!
        const lexical = instance.workspace.memory.search('晚上推荐几样零食？', { limit: 5, budgetChars: 900 })
        assert.ok(!lexical.some((r) => r.entry.id === allergy.id), 'precondition: lexical top 5 misses it')
        assert.ok(prompts[1]!.includes('用户对花生过敏'), 'the allergy is in the second prompt')
        assert.ok(result.retrievedMemoryIds.includes(allergy.id))
        assert.deepEqual(instance.workspace.audit.filter('turn').at(-1)!.data.pinned, [allergy.id])
    } finally { runtime.close() }
})
