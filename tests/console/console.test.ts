import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { assembleRuntime } from '../../src/api/runtime-factory.ts'
import type { RuntimeBundle } from '../../src/api/runtime-factory.ts'
import { createConsoleServer } from '../../src/console/server.ts'
import { ManualClock } from '../../src/kernel/util/clock.ts'
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/types.ts'
import type { InstanceRuntime } from '../../src/runtime/instance-runtime.ts'
import { jingjingTemplate } from '../../examples/characters/jingjing.ts'
import { JingjingKnowledge } from '../../examples/video-cohost/knowledge.ts'
import { JingjingGameAdapter } from '../../examples/video-cohost/game-adapter.ts'

const WORLD = 'world_jingjing_video'
const TOKEN = 'console-test-token-0123456789'
const RUN = '1:run-console'
const knowledge = new JingjingKnowledge(resolve(import.meta.dirname, '../season/fixtures/knowledge.md'))

/** Always proposes one memory, so the review path can be exercised offline. */
class ProposingProvider implements LLMProvider {
    readonly name = 'scripted'
    readonly model = 'scripted-memory'
    async complete(_request: LLMRequest): Promise<LLMResponse> {
        const text = JSON.stringify({ reply: '知道了。', proposals: [], memoryWrites: [
            { kind: 'user', title: '主播的口头禅', content: '用户说自己最爱说“稳了”', status: 'fact', salience: 0.5, tags: ['habit'] }] })
        return { text, provider: this.name, model: this.model, usage: null, latencyMs: 0, finishReason: 'stop' }
    }
}

interface Harness { runtime: RuntimeBundle; instance: InstanceRuntime; adapter: JingjingGameAdapter; clock: ManualClock; base: string; close(): Promise<void> }

async function open(dbPath: string, worldReview: 'review' | 'auto' = 'review', instanceId?: string): Promise<Harness> {
    const clock = new ManualClock(1000)
    const runtime = assembleRuntime({ dbPath, worldId: WORLD, template: jingjingTemplate, clock, provider: new ProposingProvider(), memoryReview: 'model',
        world: { enabled: true, worldIds: [WORLD], acceptObservations: true, allowedVerbs: [], allowedTargets: [] },
        configureInstance: (instance, context) => new JingjingGameAdapter({ instance, ...context, knowledge, worldReview }),
    })
    const id = instanceId ?? runtime.identityService.resolveOrCreate('sillytavern', 'streamer', '主播').instance.id
    const instance = runtime.runtimeManager.get(id)
    const server = createConsoleServer({ runtime, token: TOKEN, port: 0 })
    const { url } = await server.listen()
    return { runtime, instance, adapter: instance.extension as JingjingGameAdapter, clock, base: url,
        close: async () => { await server.close(); runtime.close() } }
}

async function call(h: Harness, path: string, body?: unknown, token = TOKEN): Promise<{ status: number; data: any }> {
    const response = await fetch(`${h.base}/api${path}`, { method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, data: await response.json() }
}

async function observe(h: Harness, eventId: string, facts: Array<{ key: string; value: string | number | boolean }>): Promise<void> {
    h.clock.advance(10)
    const result = h.runtime.world!.ingest(WORLD, [{ eventId, instanceId: h.instance.instanceId, kind: 'observation', actionId: null, result: null,
        atWorldTimeMs: h.clock.nowSim(), summary: `读取器 ${eventId}`, facts: [{ key: 'source', value: 'probably-stolen' }, ...facts] }])
    assert.deepEqual(result.rejected, [])
    await h.runtime.runtimeManager.syncWorld(h.instance.instanceId)
}

const snapshot = (h: Harness, id: string, day: number, cash: number) => observe(h, id, [{ key: 'snapshotId', value: id }, { key: 'page', value: 0 }, { key: 'pages', value: 1 },
    { key: 'ready', value: true }, { key: 'capturedAt', value: h.clock.nowSim() + 10 }, { key: 'cash', value: cash }, { key: 'save', value: RUN }, { key: 'day', value: day }])
const event = (h: Harness, id: string, tag: string) => observe(h, id, [{ key: 'event', value: tag }, { key: 'runId', value: RUN }])

test('console refuses foreign hosts and missing tokens, and serves the page without data', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cl-console-auth-'))
    const h = await open(join(directory, 'cl.sqlite'))
    try {
        assert.equal((await call(h, '/instances', undefined, 'wrong-token')).status, 401)
        const page = await fetch(`${h.base}/`)
        assert.equal(page.status, 200)
        assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'self'/)
        const port = new URL(h.base).port
        const foreign = await new Promise<number>((done, fail) => {
            import('node:http').then(({ request }) => {
                const req = request({ host: '127.0.0.1', port, path: '/api/instances', headers: { host: `evil.example:${port}`, authorization: `Bearer ${TOKEN}` } },
                    res => { res.resume(); done(res.statusCode ?? 0) })
                req.on('error', fail)
                req.end()
            }, fail)
        })
        assert.equal(foreign, 403)
        assert.throws(() => createConsoleServer({ runtime: h.runtime, token: TOKEN, host: '0.0.0.0' }))
    } finally { await h.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('six-semantics view and memory review: model memories wait, approval writes with provenance, rejection writes nothing', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cl-console-memory-'))
    const dbPath = join(directory, 'cl.sqlite')
    let h = await open(dbPath)
    try {
        const before = h.instance.workspace.memory.list({ limit: 1e9 }).length
        await h.runtime.runtimeManager.send(h.instance, { identityKey: 'streamer', text: '我最爱说稳了' })
        await h.runtime.runtimeManager.send(h.instance, { identityKey: 'streamer', text: '再说一遍，稳了' })
        h.runtime.runtimeManager.saveSnapshot(h.instance)
        assert.equal(h.instance.workspace.memory.list({ limit: 1e9 }).length, before, 'held memories are not written')

        const view = await call(h, `/instances/${h.instance.instanceId}/semantics`)
        assert.equal(view.status, 200)
        for (const key of ['self', 'situation', 'observation', 'memory', 'motivation', 'affordance']) assert.ok(key in view.data, key)
        assert.deepEqual(view.data.affordance.world, [])
        assert.equal(view.data.review.memories, 2)
        assert.deepEqual(view.data.plugins, [{ id: 'probably-stolen', title: 'Probably Stolen · 绝命鲸师' }])

        // Restart keeps the queue.
        const id = h.instance.instanceId
        await h.close()
        h = await open(dbPath, 'review', id)
        const pending = (await call(h, `/instances/${id}/memory-review?status=pending`)).data
        assert.equal(pending.length, 2)
        const approved = await call(h, `/instances/${id}/memory-review/${pending[0].id}`, { decision: 'approve' })
        assert.equal(approved.data.status, 'approved')
        const written = h.instance.workspace.memory.get(approved.data.entryId)!
        assert.equal(written.sourceRef, pending[0].sourceRef)
        assert.equal(written.origin, 'user_message')
        assert.equal((await call(h, `/instances/${id}/memory-review/${pending[1].id}`, { decision: 'reject' })).data.status, 'rejected')
        assert.equal(h.instance.workspace.memory.list({ limit: 1e9 }).length, before + 1)
        assert.equal((await call(h, `/instances/${id}/memory-review/${pending[1].id}`, { decision: 'approve' })).status, 409, 'decisions are final')

        const deleted = await call(h, `/instances/${id}/memories/${written.id}/delete`, {})
        assert.equal(deleted.status, 200)
        assert.notEqual(h.instance.workspace.memory.get(written.id)?.deletedAtSim ?? null, null)
        const listed = (await call(h, `/instances/${id}/memories?deleted=1`)).data
        assert.ok(listed.some((memory: { id: string }) => memory.id === written.id))
    } finally { await h.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('world-event review: key effects wait for approval, routine ones pass, plugin actions drive the season', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cl-console-world-'))
    const h = await open(join(directory, 'cl.sqlite'))
    try {
        const id = h.instance.instanceId
        await snapshot(h, 'snap-1', 1, -200)
        // day_start is routine (B0 opens), the deficit is a key event and waits.
        assert.deepEqual(h.adapter.season.state().progress.map(item => item.beatId), ['B0'])
        await event(h, 'kill-1', 'kill:ai_controlled')
        assert.ok(h.instance.workspace.observation.latest(5).some(percept => percept.events.includes('kill:ai_controlled')), 'the event is observed live')
        assert.equal(h.instance.workspace.memory.list({ tags: ['grudge'], limit: 1e9 }).length, 0, 'its effect waits')

        const panel = (await call(h, `/instances/${id}/plugins/probably-stolen`)).data
        const reviewPanel = panel.panels.find((item: { id: string }) => item.id === 'world-review')
        assert.equal(reviewPanel.badge, 2)
        const rows = reviewPanel.sections.find((section: { title: string }) => section.title === '待审').rows
        const killRow = rows.find((row: { cells: { events: string } }) => row.cells.events === 'kill:ai_controlled')
        const approve = killRow.actions.find((action: { id: string }) => action.id === 'world.approve')
        assert.equal((await call(h, `/instances/${id}/plugins/probably-stolen/actions/${approve.id}`, { params: approve.params })).status, 200)
        assert.equal(h.instance.workspace.memory.list({ tags: ['grudge'], limit: 1e9 })[0]!.sourceRef, 'kill-1')

        const deficitRow = rows.find((row: { cells: { events: string } }) => row.cells.events === 'deficit')
        await call(h, `/instances/${id}/plugins/probably-stolen/actions/world.reject`, { params: { id: deficitRow.cells.id } })
        await event(h, 'kill-1', 'kill:ai_controlled')
        assert.equal(h.adapter.worldReview.list('pending').length, 0, 'replayed events are not queued again')

        await call(h, `/instances/${id}/plugins/probably-stolen/actions/world.mode`, { params: { mode: 'auto' } })
        await event(h, 'kill-2', 'kill:ai_controlled')
        assert.equal(h.instance.workspace.memory.list({ tags: ['grudge'], limit: 1e9 }).length, 2)

        // Episode close and item-by-item review through the plugin.
        await h.runtime.runtimeManager.send(h.instance, { identityKey: 'streamer', text: '第3天前我一定让资金转正' })
        assert.equal((await call(h, `/instances/${id}/plugins/probably-stolen/actions/episode.close`, { params: {} })).status, 200)
        const review = h.adapter.season.pendingReview()!
        const flagId = review.flags[0]!
        const noDeadline = await call(h, `/instances/${id}/plugins/probably-stolen/actions/review.flag`, { params: { reviewId: review.reviewId, id: flagId, decision: 'accept', dueDay: null } })
        assert.equal(noDeadline.status, 200, 'the candidate carries its own deadline from the speech')
        assert.equal(h.instance.workspace.motivation.open().filter(flag => flag.owner === 'user').length, 1)
        for (const memory of review.memories) {
            await call(h, `/instances/${id}/plugins/probably-stolen/actions/review.memory`, { params: { reviewId: review.reviewId, id: memory.id, decision: 'accept' } })
        }
        assert.equal(h.adapter.season.pendingReview(), null, 'all candidates decided closes the review')
        const bad = await call(h, `/instances/${id}/plugins/probably-stolen/actions/nope`, { params: {} })
        assert.equal(bad.status, 409)
    } finally { await h.close(); rmSync(directory, { recursive: true, force: true }) }
})
