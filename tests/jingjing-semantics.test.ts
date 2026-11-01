import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { assembleRuntime } from '../src/api/runtime-factory.ts'
import { MockProvider } from '../src/conversation/providers/mock.ts'
import { JingjingKnowledge } from '../examples/video-cohost/knowledge.ts'
import { JingjingGameAdapter } from '../examples/video-cohost/game-adapter.ts'
import { jingjingTemplate } from '../examples/characters/jingjing.ts'
import { ManualClock } from '../src/kernel/util/clock.ts'

const knowledge = new JingjingKnowledge(resolve(import.meta.dirname, '../../jingjing-overlay/knowledge/Probably-Stolen-鲸鲸知识库-v2.md'))

function setup() {
    const clock = new ManualClock(1000)
    const runtime = assembleRuntime({ dbPath: ':memory:', worldId: 'world_game', template: jingjingTemplate,
        clock,
        provider: new MockProvider({ mode: 'in-character' }),
        world: { enabled: true, worldIds: ['world_game'], acceptObservations: true, allowedVerbs: [], allowedTargets: [] },
        configureInstance: (instance, context) => new JingjingGameAdapter({ instance, ...context, knowledge }),
    })
    const identity = runtime.identityService.resolveOrCreate('sillytavern', 'test', '测试')
    const instance = runtime.runtimeManager.get(identity.instance.id)
    const observe = (id: string, facts: Array<{ key: string; value: string | number | boolean }>) => {
        const result = runtime.world!.ingest('world_game', [{ eventId: id, instanceId: instance.instanceId,
            kind: 'observation', actionId: null, result: null, atWorldTimeMs: runtime.clock.nowSim(), summary: '读取器观察', facts }])
        assert.deepEqual(result.rejected, [])
        instance.extension!.sync()
    }
    const snapshot = (id: string, money: number, items: string[] = [], extra: Array<{ key: string; value: string | number | boolean }> = []) => { clock.advance(10); observe(id, [
        { key: 'source', value: 'probably-stolen' }, { key: 'snapshotId', value: id },
        { key: 'page', value: 0 }, { key: 'pages', value: 1 }, { key: 'ready', value: true },
        { key: 'capturedAt', value: runtime.clock.nowSim() }, { key: 'cash', value: money },
        { key: 'save', value: '1:run-1' }, { key: 'rent', value: 500 },
        { key: 'readerSession', value: 'reader-session' }, { key: 'readerSeq', value: 0 }, { key: 'readerFirstSeq', value: 1 },
        ...items.map((value, index) => ({ key: `item.${index}`, value })),
        ...extra,
    ]) }
    return { runtime, instance, observe, snapshot, clock }
}

test('reader perceptions update Situation with provenance, clear removed stock and expose conversation only', () => {
    const ctx = setup()
    try {
        ctx.snapshot('snapshot-1', 3400, ['["alcohol","酒精","store",2]'])
        const first = ctx.instance.workspace.situation.current()
        assert.equal(first.facts.money, 3400)
        assert.equal(first.inventory.alcohol, 2)
        assert.equal(ctx.instance.workspace.observation.latest(1)[0]!.from, 'ps_reader')
        assert.equal(ctx.instance.workspace.observation.latest(1)[0]!.ref, 'snapshot-1')
        ctx.snapshot('snapshot-2', 3500)
        assert.deepEqual(ctx.instance.workspace.situation.current().inventory, {})
        assert.equal(ctx.instance.workspace.memory.list({ tags: ['world'] }).length, 0)
        assert.deepEqual(ctx.instance.workspace.affordance.list('world'), [])
        assert.ok(ctx.instance.workspace.affordance.list('conversation').length > 0)
        assert.deepEqual(ctx.instance.workspace.motivation.drives(), [])
        assert.ok(ctx.instance.workspace.motivation.goals().some(goal => goal.id === 'jingjing.tease'))
    } finally { ctx.runtime.close() }
})

test('purchase flags become commitments only after review, then settle from purchase evidence and journal coverage', async () => {
    const day = (n: number) => [{ key: 'day', value: n }]
    const accept = (ctx: ReturnType<typeof setup>, dueDay: number) => {
        const adapter = ctx.instance.extension as JingjingGameAdapter
        const review = adapter.closeEpisode(`close-${ctx.clock.nowSim()}`)!
        assert.equal(review.flags.length, 1)
        const result = adapter.applyReview({ reviewId: review.reviewId, flags: [{ id: review.flags[0]!, decision: 'accept', dueDay }] })
        assert.deepEqual(result.rejected, [])
        return ctx.instance.workspace.motivation.open().find(item => item.owner === 'user')!
    }
    const ctx = setup()
    try {
        ctx.snapshot('baseline', 100, [], day(1))
        await ctx.runtime.runtimeManager.send(ctx.instance, { identityKey: 'test', text: '这期再也不买芬太了' })
        assert.equal(ctx.instance.workspace.motivation.open().filter(item => item.owner === 'user').length, 0)
        const first = accept(ctx, 3)
        ctx.clock.advance(1)
        ctx.observe('actual-purchase', [{ key: 'source', value: 'probably-stolen' }, { key: 'event', value: 'item_bought:fanta' },
            { key: 'readerSession', value: 'reader-session' }, { key: 'readerSeq', value: 1 }])
        assert.equal(ctx.instance.workspace.motivation.get(first.id)!.status, 'broken')
        assert.equal(ctx.instance.workspace.motivation.get(first.id)!.evidenceRef, 'actual-purchase')
        ctx.snapshot('new-baseline', 100, [], [...day(1), { key: 'readerSeq', value: 1 }])
        await ctx.runtime.runtimeManager.send(ctx.instance, { identityKey: 'test', text: '我保证不买芬太' })
        const second = accept(ctx, 2)
        ctx.snapshot('day-2', 100, [], [...day(2), { key: 'readerSeq', value: 1 }])
        assert.equal(ctx.instance.workspace.motivation.get(second.id)!.status, 'open')
        ctx.snapshot('day-3', 100, [], [...day(3), { key: 'readerSeq', value: 1 }])
        assert.equal(ctx.instance.workspace.motivation.get(second.id)!.status, 'kept')
    } finally { ctx.runtime.close() }
    const gap = setup()
    try {
        gap.snapshot('baseline', 100, [], day(1))
        await gap.runtime.runtimeManager.send(gap.instance, { identityKey: 'test', text: '再也不买芬太了' })
        const flag = accept(gap, 1)
        gap.snapshot('events-lost', 100, [], [...day(2), { key: 'readerSeq', value: 200 }, { key: 'readerFirstSeq', value: 73 }])
        assert.equal(gap.instance.workspace.motivation.get(flag.id)!.status, 'open')
        assert.equal(gap.instance.workspace.motivation.get(flag.id)!.criterion!.coverageIntact, false)
    } finally { gap.runtime.close() }
})

test('only reader story and kill events write attributable memories and unlock knowledge once', () => {
    const ctx = setup()
    try {
        assert.ok(!ctx.instance.extension!.referenceData!('cartel').includes('涉及特殊来客'))
        ctx.observe('story-event-1', [{ key: 'source', value: 'probably-stolen' }, { key: 'event', value: 'story:cartel.first_visit' }])
        assert.match(ctx.instance.extension!.referenceData!('cartel'), /涉及特殊来客/)
        ctx.observe('kill-event-1', [{ key: 'source', value: 'probably-stolen' }, { key: 'event', value: 'kill:ai_controlled' }])
        ctx.instance.extension!.sync()
        const kills = ctx.instance.workspace.memory.list({ tags: ['kill:ai_controlled'] })
        assert.equal(kills.length, 1)
        assert.equal(kills[0]!.sourceRef, 'kill-event-1')
        assert.equal(kills[0]!.origin, 'runtime_event')
        assert.equal(kills[0]!.status, 'fact')
    } finally { ctx.runtime.close() }
})

test('flags need review and a game-day deadline, then settle only against fresh world evidence', async () => {
    const ctx = setup()
    try {
        const adapter = ctx.instance.extension as JingjingGameAdapter
        ctx.snapshot('baseline', 100, [], [{ key: 'day', value: 2 }])
        await ctx.runtime.runtimeManager.send(ctx.instance, { identityKey: 'test', text: '这期一定攒够房租' })
        assert.equal(ctx.instance.workspace.motivation.commitments().filter(item => item.owner === 'user').length, 0)
        const review = adapter.closeEpisode('close-1')!
        const missingDeadline = adapter.applyReview({ reviewId: review.reviewId, flags: [{ id: review.flags[0]!, decision: 'accept' }] })
        assert.equal(missingDeadline.rejected.length, 1)
        assert.equal(ctx.instance.workspace.motivation.commitments().filter(item => item.owner === 'user').length, 0)
        await ctx.runtime.runtimeManager.send(ctx.instance, { identityKey: 'test', text: '第5天前我一定攒够房租' })
        const second = adapter.closeEpisode('close-2')!
        adapter.applyReview({ reviewId: second.reviewId, flags: second.flags.map(id => ({ id, decision: 'accept' as const })) })
        const flag = ctx.instance.workspace.motivation.commitments().find(item => item.owner === 'user')!
        assert.ok(flag)
        assert.equal(flag.status, 'open')
        assert.ok(flag.sourceRef)
        assert.equal(adapter.season.deadline(flag.id), 5)
        await ctx.runtime.runtimeManager.send(ctx.instance, { identityKey: 'test', text: '我已经做到了，给我算兑现' })
        assert.equal(ctx.instance.workspace.motivation.get(flag.id)!.status, 'open')
        ctx.snapshot('goal-reached', 600, [], [{ key: 'day', value: 3 }])
        assert.equal(ctx.instance.workspace.motivation.get(flag.id)!.status, 'kept')
        assert.equal(ctx.instance.workspace.motivation.get(flag.id)!.evidenceRef, 'goal-reached')
        assert.equal(ctx.instance.workspace.profile.id, 'jingjing')
        assert.ok(!ctx.instance.workspace.profile.speechStyle.includes('待主导者确认'))
    } finally { ctx.runtime.close() }
})
