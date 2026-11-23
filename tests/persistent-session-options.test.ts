import test from 'node:test'
import assert from 'node:assert/strict'
import { ManualClock } from '../src/kernel/util/clock.ts'
import { SeededRng } from '../src/kernel/util/rng.ts'
import { SequentialIdFactory } from '../src/kernel/util/ids.ts'
import { CharacterDatabase } from '../src/persistence/database.ts'
import { CharacterPersistence } from '../src/persistence/store.ts'
import { defineTemplate } from '../src/character/template.ts'
import { PersistentSession } from '../src/character/persistent-session.ts'
import { WorldService } from '../src/kernel/world/service.ts'
import type { LLMProvider, LLMRequest } from '../src/types.ts'
import { shenZhiweiProfile, shenZhiweiVoice } from '../examples/characters/shen-zhiwei.ts'

// M0 stress P4/P5 (2026-11-20): PersistentSession gained an optional streaming callback and world
// binding. Omitting both must keep the old non-streaming, world-free behaviour.

const INSTANCE = 'inst_opts'
const WORLD = 'world_opts'
const REPLY = JSON.stringify({
    reply: '好，我去桌边看看。', proposals: [], memoryWrites: [],
    worldActions: [{ verb: 'use', target: 'desk_01', reason: '想整理一下', expectation: '桌面变整齐' }],
})

function recordingProvider(): { provider: LLMProvider; requests: LLMRequest[] } {
    const requests: LLMRequest[] = []
    const provider: LLMProvider = {
        name: 'fixed',
        model: 'fixed',
        async complete(request: LLMRequest) {
            requests.push(request)
            request.onTextDelta?.(REPLY)
            return { text: REPLY, provider: 'fixed', model: 'fixed', usage: null, latencyMs: 0, finishReason: 'stop' }
        },
    }
    return { provider, requests }
}

function open(provider: LLMProvider, world: boolean): { session: PersistentSession; db: CharacterDatabase } {
    const db = new CharacterDatabase(':memory:')
    const persistence = new CharacterPersistence(db)
    const template = defineTemplate({
        version: 1, profile: shenZhiweiProfile, voice: shenZhiweiVoice, timeline: [], createdAtWall: '2026-01-01T00:00:00.000Z',
    })
    persistence.putTemplate(template)
    persistence.createInstance({ id: INSTANCE, template, playerId: 'p', worldId: WORLD, label: 'opts' }, INSTANCE, '2026-01-01T00:00:00.000Z')
    const clock = new ManualClock(0)
    const worldService = world
        ? new WorldService({
            clock,
            ids: new SequentialIdFactory(),
            lookupInstance: (id) => (id === INSTANCE ? { worldId: WORLD } : null),
            worldIds: [WORLD],
            allowedVerbs: ['use'],
            allowedTargets: ['desk_01'],
        })
        : null
    const session = PersistentSession.open({
        persistence, instanceId: INSTANCE, provider, clock, ids: new SequentialIdFactory(), rng: new SeededRng(1),
        ...(worldService ? { world: { service: worldService, instanceId: INSTANCE, worldId: WORLD } } : {}),
    })
    return { session, db }
}

test('without the new options: no streaming, no world protocol, worldActions ignored', async () => {
    const { provider, requests } = recordingProvider()
    const { session, db } = open(provider, false)
    try {
        const result = await session.send('你在干嘛？')
        assert.equal(requests[0]!.onTextDelta, undefined)
        assert.ok(!requests[0]!.system.includes('worldActions'))
        assert.equal(result.worldActions, undefined)
        assert.equal(result.reply, '好，我去桌边看看。')
    } finally { session.close(); db.close() }
})

test('onReplyDelta turns streaming on and receives reply text only', async () => {
    const { provider, requests } = recordingProvider()
    const { session, db } = open(provider, false)
    const deltas: string[] = []
    try {
        const result = await session.send('你在干嘛？', (t) => deltas.push(t))
        assert.equal(typeof requests[0]!.onTextDelta, 'function')
        assert.equal(deltas.join(''), result.reply)
    } finally { session.close(); db.close() }
})

test('a world binding adds the world protocol and runs admission', async () => {
    const { provider, requests } = recordingProvider()
    const { session, db } = open(provider, true)
    try {
        const result = await session.send('你在干嘛？')
        assert.ok(requests[0]!.system.includes('worldActions'))
        assert.ok(result.worldActions)
        assert.equal(result.worldActions.admitted.length + result.worldActions.rejected.length, 1)
    } finally { session.close(); db.close() }
})
