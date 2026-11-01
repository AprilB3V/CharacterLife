import assert from 'node:assert/strict'
import test from 'node:test'
import { assembleRuntime } from '../../src/api/runtime-factory.ts'
import { createApiServer } from '../../src/api/server.ts'
import { MockProvider } from '../../src/conversation/providers/mock.ts'
import { SpyProvider } from '../helpers.ts'

test('native observations reach model data without becoming user speech or system instructions', async () => {
    const provider = new SpyProvider(new MockProvider({ mode: 'in-character' }))
    const runtime = assembleRuntime({
        dbPath: ':memory:', worldId: 'world_game', provider,
        world: { enabled: true, worldIds: ['world_game'], allowedVerbs: [], allowedTargets: [], acceptObservations: true },
    })
    const api = createApiServer({ runtime, port: 0, token: 'test-chat-token-123456', logger: () => {},
        world: { token: 'test-world-token-123456' } })
    const { url } = await api.listen()
    const call = async (path: string, token: string, body?: unknown) => {
        const response = await fetch(url + path, { method: body ? 'POST' : 'GET',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', connection: 'close' },
            ...(body ? { body: JSON.stringify(body) } : {}) })
        return { status: response.status, body: await response.json() as { instanceId: string; accepted: string[] } }
    }
    try {
        await call('/v1/sessions', 'test-chat-token-123456', {})
        const identity = await call('/v1/identity/me', 'test-chat-token-123456')
        const event = { eventId: 'snapshot-1', kind: 'observation', instanceId: identity.body.instanceId,
            atWorldTimeMs: 10, summary: '资金快照', facts: [{ key: 'cash', value: 1200 },
                { key: 'item', value: '放大镜' }], actionId: null, result: null }
        const ingest = await call('/v1/world/events', 'test-world-token-123456', { worldId: 'world_game', events: [event] })
        assert.deepEqual(ingest.body.accepted, ['snapshot-1'], JSON.stringify(ingest.body))
        const memoriesBefore = runtime.persistence.listMemories(identity.body.instanceId).length
        await call('/v1/messages', 'test-chat-token-123456', { text: '我现在有什么？' })
        assert.ok(!provider.lastRequest!.system.includes('放大镜'))
        assert.ok(!provider.lastRequest!.system.includes('1200'))
        const data = provider.lastRequest!.messages.map(message => message.content).join('\n')
        assert.match(data, /1200/)
        assert.match(data, /放大镜/)
        assert.equal(runtime.persistence.listMemories(identity.body.instanceId).length, memoriesBefore)
        assert.deepEqual(runtime.world!.manifest(), [])
    } finally {
        await api.close()
        runtime.close()
    }
})
