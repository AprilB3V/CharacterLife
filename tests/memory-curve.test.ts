import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { DEFAULT_CURVE, initialRecallState, recallTier, reinforce, retention } from '../src/kernel/memory/curve.ts'
import { PersistentSession } from '../src/character/persistent-session.ts'
import { CharacterDatabase } from '../src/persistence/database.ts'
import { SeededRng } from '../src/kernel/util/rng.ts'
import { createRig, DAY } from './cross_session/helpers.ts'
import type { Rig } from './cross_session/helpers.ts'
import type { MemoryEntry } from '../src/kernel/types.ts'
import type { LLMProvider, LLMRequest } from '../src/types.ts'

const CURVE = DEFAULT_CURVE

function entry(extra: Partial<MemoryEntry> = {}): MemoryEntry {
    return {
        id: 'm', kind: 'user', title: 't', content: 'c', status: 'fact', origin: 'user_message', trust: 'trusted',
        confirmed: false, salience: 0.5, tags: [], createdAtSim: 0, createdAtWall: '', sourceRef: null, deletedAtSim: null,
        ...extra,
    } as MemoryEntry
}

test('retention decays from creation; pinned facts never decay', () => {
    const e = entry({ salience: 0.5 })
    const s = initialRecallState(e, CURVE)
    assert.equal(s.stability, 5 * DAY)
    assert.equal(retention(e, undefined, 0, CURVE), 1)
    assert.ok(Math.abs(retention(e, undefined, 5 * DAY, CURVE) - Math.exp(-1)) < 1e-9)
    assert.equal(retention(entry({ tags: ['pin:safety'] }), undefined, 100 * DAY, CURVE), 1)
})

test('tiers: clear, fuzzy, forgotten', () => {
    assert.equal(recallTier(0.9, CURVE), 'clear')
    assert.equal(recallTier(0.5, CURVE), 'clear')
    assert.equal(recallTier(0.3, CURVE), 'fuzzy')
    assert.equal(recallTier(0.15, CURVE), 'fuzzy')
    assert.equal(recallTier(0.1, CURVE), 'forgotten')
})

test('consolidation follows spacing: a faded recall grows stability, an instant repeat barely does', () => {
    const s = { stability: DAY, lastRecalledSim: null, recalls: 0 }
    const late = reinforce(s, 0.1, 10, CURVE)
    assert.ok(Math.abs(late.stability - DAY * 3.7) < 1)
    assert.equal(late.lastRecalledSim, 10)
    assert.equal(late.recalls, 1)
    const again = reinforce(late, 1, 11, CURVE)
    assert.equal(again.stability, late.stability)
})

/** Writes the given memories on the first turn, then replies plainly; records every prompt. */
function scriptedProvider(writes: unknown[]): { provider: LLMProvider; prompts: string[] } {
    const prompts: string[] = []
    let turn = 0
    const provider: LLMProvider = {
        name: 'fixed',
        model: 'fixed',
        async complete(request: LLMRequest) {
            prompts.push([request.system, ...request.messages.map((m) => m.content)].join('\n'))
            const text = JSON.stringify({ reply: '嗯。', proposals: [], memoryWrites: turn++ === 0 ? writes : [] })
            return { text, provider: 'fixed', model: 'fixed', usage: null, latencyMs: 0, finishReason: 'stop' }
        },
    }
    return { provider, prompts }
}

function open(rig: Rig, provider: LLMProvider): PersistentSession {
    return PersistentSession.open({
        persistence: rig.persistence,
        instanceId: rig.instance.id,
        provider,
        clock: rig.clock,
        ids: rig.ids,
        rng: new SeededRng(1),
        auditFile: null,
    })
}

const FACT = { kind: 'user', title: '用户的自行车是蓝色的', content: '用户骑一辆蓝色自行车上班。', status: 'fact', salience: 0.5, cues: ['单车'] }

test('a fact unrecalled for weeks leaves lexical retrieval; a cue word still brings it back', async () => {
    const rig = createRig()
    const { provider, prompts } = scriptedProvider([FACT])
    const session = open(rig, provider)
    try {
        await session.send('记一下。')
        session.workspace.advanceTo(20 * DAY)
        await session.send('我的自行车是什么颜色？')
        assert.ok(!prompts.at(-1)!.includes('蓝色自行车'), 'forgotten: lexical retrieval skips it')
        await session.send('我的单车是什么颜色？')
        assert.ok(prompts.at(-1)!.includes('蓝色自行车'), 'the cue brings it back')
    } finally {
        session.close('user_exit')
    }
})

test('a faded fact is marked vague; recalling it consolidates and persists across a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'curve-'))
    const rig = createRig({ file: join(dir, 'c.db') })
    const { provider, prompts } = scriptedProvider([FACT])
    let session = open(rig, provider)
    let id: string
    try {
        await session.send('记一下。')
        id = session.workspace.memory.list().find((m) => m.title === FACT.title)!.id
        session.workspace.advanceTo(5 * DAY)
        await session.send('我的自行车是什么颜色？')
        assert.match(prompts.at(-1)!, /印象模糊[^\n]*蓝色自行车|蓝色自行车[^\n]*/)
        assert.ok(prompts.at(-1)!.includes('印象模糊'))
        const state = session.workspace.memory.recallState(id)!
        assert.equal(state.recalls, 1)
        assert.ok(state.stability > 5 * DAY * 2, 'a faded recall more than doubles stability')
        const audit = session.workspace.audit.filter('turn').at(-1)!
        assert.deepEqual(audit.data.fuzzy, [id])
    } finally {
        session.close('user_exit')
    }
    session = open(rig, scriptedProvider([]).provider)
    try {
        assert.deepEqual(session.workspace.memory.recallState(id), rig.persistence.listMemoryRecall(rig.instance.id)[id])
        assert.equal(session.workspace.memory.recallState(id)!.recalls, 1)
    } finally {
        session.close('user_exit')
        rig.db.close()
    }
})

test('snapshot JSON keeps recall state; old snapshots without it load as never recalled', async () => {
    const rig = createRig()
    const session = open(rig, scriptedProvider([FACT]).provider)
    try {
        await session.send('记一下。')
        await session.send('我的自行车是什么颜色？')
        const memory = session.workspace.memory
        const json = memory.toJSON() as Record<string, unknown>
        assert.equal(Object.keys(json.recall as object).length, 1)
        memory.fromJSON({ ...json, recall: undefined })
        assert.deepEqual(memory.recallStates(), {})
        memory.fromJSON(json)
        assert.equal(Object.keys(memory.recallStates()).length, 1)
    } finally {
        session.close('user_exit')
    }
})

test('V3 database upgrades to V4: adds memory_recall, keeps memories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'curve-v3-'))
    const file = join(dir, 'v3.db')
    {
        const rig = createRig({ file })
        rig.db.exec('DROP TABLE memory_recall')
        rig.db.exec(`UPDATE meta SET value = '3' WHERE key = 'schema_version'`)
        rig.db.close()
    }
    const db = new CharacterDatabase(file)
    try {
        const version = db.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string }
        assert.equal(version.value, '4')
        assert.ok(db.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_recall'`).get())
        assert.ok(db.db.prepare(`SELECT id FROM instances`).get(), 'existing rows stay')
    } finally {
        db.close()
    }
})

// Codex review 2026-11-19: consolidation ran before the call, so a provider error still refreshed the memory.
test('a failed model call consolidates nothing', async () => {
    const rig = createRig()
    let fail = false
    const { provider: inner } = scriptedProvider([FACT])
    const provider: LLMProvider = {
        name: 'flaky',
        model: 'flaky',
        async complete(request: LLMRequest) {
            if (fail) throw new Error('offline')
            return inner.complete(request)
        },
    }
    const session = open(rig, provider)
    try {
        await session.send('记一下。')
        session.workspace.advanceTo(5 * DAY)
        fail = true
        await session.send('我的自行车是什么颜色？')
        assert.deepEqual(session.workspace.memory.recallStates(), {})
    } finally {
        session.close('user_exit')
    }
})

// Codex review 2026-11-19: memories cut by memoryLimit were consolidated though never shown.
test('only memories rendered into the prompt are consolidated', async () => {
    const rig = createRig()
    const second = { ...FACT, title: '用户的自行车很旧', content: '用户的自行车用了五年，车铃坏了。', cues: [] }
    const { provider } = scriptedProvider([FACT, second])
    const session = PersistentSession.open({
        persistence: rig.persistence, instanceId: rig.instance.id, provider, clock: rig.clock, ids: rig.ids,
        rng: new SeededRng(1), auditFile: null, budget: { memoryLimit: 1 },
    })
    try {
        await session.send('记一下。')
        await session.send('我的自行车怎么样？')
        assert.equal(Object.keys(session.workspace.memory.recallStates()).length, 1)
    } finally {
        session.close('user_exit')
    }
})

// Codex review 2026-11-19: without a ContextManager nothing was ever consolidated.
test('the plain assembly path (no ContextManager) consolidates too', async () => {
    const { createRig: createPlainRig, cleanupRigs } = await import('./helpers.ts')
    const { provider } = scriptedProvider([FACT])
    const rig = createPlainRig({ provider })
    try {
        await rig.service.send('记一下。')
        await rig.service.send('我的自行车是什么颜色？')
        assert.equal(Object.keys(rig.workspace.memory.recallStates()).length, 1)
    } finally {
        cleanupRigs()
    }
})

test('associates: most shared cue keys first; needs minShared; skips recalled, pinned, deleted, untrusted', async () => {
    const { associates } = await import('../src/kernel/memory/curve.ts')
    const cue = (...keys: string[]) => keys.map((k) => `cue:${k}`)
    const recalled = [entry({ id: 'train', tags: cue('半马', '跑步', '十五公里') })]
    const pool = [
        ...recalled,
        entry({ id: 'goal', tags: cue('半马', '跑步', '两小时') }),
        entry({ id: 'weak', tags: cue('半马', '深圳') }),
        entry({ id: 'three', tags: cue('半马', '跑步', '十五公里') }),
        entry({ id: 'pin', tags: ['pin:safety', ...cue('半马', '跑步')] }),
        entry({ id: 'gone', tags: cue('半马', '跑步'), deletedAtSim: 1 }),
        entry({ id: 'bad', tags: cue('半马', '跑步'), trust: 'untrusted' }),
    ]
    assert.deepEqual(associates(recalled, pool, { limit: 3, minShared: 2 }).map((e) => e.id), ['three', 'goal'])
    assert.deepEqual(associates(recalled, pool, { limit: 1, minShared: 2 }).map((e) => e.id), ['three'])
    assert.deepEqual(associates(recalled, pool, { limit: 3, minShared: 1 }).map((e) => e.id), ['three', 'goal', 'weak'])
})

// M0 curve run 2026-11-19: the race came up on day 3 and day 8, yet the goal fact faded by day 25.
test('recalling a memory makes its cue-sharing neighbours sturdier without counting as a recall', async () => {
    const rig = createRig()
    const goal = { kind: 'user', title: '半马目标两小时内', content: '用户准备半程马拉松，目标两小时以内。', status: 'fact', salience: 0.5, cues: ['半马', '跑步', '两小时'] }
    const training = { kind: 'episodic', title: '训练跑了十五公里', content: '用户今天练了十五公里，腿酸。', status: 'fact', salience: 0.5, cues: ['半马', '跑步', '十五公里'] }
    // memoryLimit 1: lexical retrieval returns only the training note, so the goal can only be associated.
    const session = PersistentSession.open({
        persistence: rig.persistence, instanceId: rig.instance.id, provider: scriptedProvider([goal, training]).provider,
        clock: rig.clock, ids: rig.ids, rng: new SeededRng(1), auditFile: null, conversation: { memoryLimit: 1 },
    })
    try {
        await session.send('记一下。')
        const memory = session.workspace.memory
        const goalId = memory.list().find((m) => m.title === goal.title)!.id
        session.workspace.advanceTo(4 * DAY)
        await session.send('今天又跑了十五公里。')
        const state = memory.recallState(goalId)!
        assert.ok(state.stability > 5 * DAY, 'the goal grew sturdier')
        assert.equal(state.lastRecalledSim, null, 'but was not recalled')
        assert.equal(state.recalls, 0)
        assert.deepEqual(rig.persistence.listMemoryRecall(rig.instance.id)[goalId], state)
    } finally {
        session.close('user_exit')
    }
})

test('association off: neighbours stay untouched', async () => {
    const { DEFAULT_CURVE: curve } = await import('../src/kernel/memory/curve.ts')
    const rig = createRig()
    const goal = { kind: 'user', title: '半马目标两小时内', content: '用户准备半程马拉松，目标两小时以内。', status: 'fact', salience: 0.5, cues: ['半马', '跑步', '两小时'] }
    const training = { kind: 'episodic', title: '训练跑了十五公里', content: '用户今天练了十五公里，腿酸。', status: 'fact', salience: 0.5, cues: ['半马', '跑步', '十五公里'] }
    const session = PersistentSession.open({
        persistence: rig.persistence, instanceId: rig.instance.id, provider: scriptedProvider([goal, training]).provider,
        clock: rig.clock, ids: rig.ids, rng: new SeededRng(1), auditFile: null,
        conversation: { memoryLimit: 1, memoryCurve: { ...curve, association: null } },
    })
    try {
        await session.send('记一下。')
        const goalId = session.workspace.memory.list().find((m) => m.title === goal.title)!.id
        session.workspace.advanceTo(4 * DAY)
        await session.send('今天又跑了十五公里。')
        assert.equal(session.workspace.memory.recallState(goalId), null)
    } finally {
        session.close('user_exit')
    }
})

test('memory curve off: no decay, no recall bookkeeping', async () => {
    const rig = createRig()
    const { provider, prompts } = scriptedProvider([FACT])
    const session = PersistentSession.open({
        persistence: rig.persistence, instanceId: rig.instance.id, provider, clock: rig.clock, ids: rig.ids,
        rng: new SeededRng(1), auditFile: null, conversation: { memoryCurve: null },
    })
    try {
        await session.send('记一下。')
        session.workspace.advanceTo(20 * DAY)
        await session.send('我的自行车是什么颜色？')
        assert.ok(prompts.at(-1)!.includes('蓝色自行车'))
        assert.ok(!prompts.at(-1)!.includes('印象模糊'))
        assert.deepEqual(session.workspace.memory.recallStates(), {})
    } finally {
        session.close('user_exit')
    }
})
