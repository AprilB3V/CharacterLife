import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { assembleRuntime } from '../../src/api/runtime-factory.ts'
import type { RuntimeBundle } from '../../src/api/runtime-factory.ts'
import { MockProvider } from '../../src/conversation/providers/mock.ts'
import { ManualClock } from '../../src/kernel/util/clock.ts'
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/types.ts'
import type { InstanceRuntime } from '../../src/runtime/instance-runtime.ts'
import { jingjingTemplate } from '../../examples/characters/jingjing.ts'
import { JingjingKnowledge } from '../../examples/video-cohost/knowledge.ts'
import { JingjingGameAdapter } from '../../examples/video-cohost/game-adapter.ts'
import { SEASON_CONFIG, findRecipeTerms } from '../../examples/video-cohost/season/config.ts'
import { MAX_STANCE_CHARS, seasonOneScript } from '../../examples/video-cohost/season/script.ts'
import { decisionsFromFile, submitDecision } from '../../examples/video-cohost/season/review-files.ts'
import type { PendingReviewFile } from '../../examples/video-cohost/season/review-files.ts'
import { RUN, OTHER_RUN, SEASON_ONE_RUN } from './fixtures/season-one-run.ts'
import type { FixtureStep } from './fixtures/season-one-run.ts'

const WORLD = 'world_jingjing_video'
const knowledge = new JingjingKnowledge(resolve(import.meta.dirname, 'fixtures/knowledge.md'))

/** Records every model request so the injected text can be audited. */
class RecordingProvider implements LLMProvider {
    readonly name = 'recording'
    readonly model = 'mock-recording'
    readonly requests: LLMRequest[] = []
    #inner = new MockProvider({ mode: 'in-character' })
    async complete(request: LLMRequest): Promise<LLMResponse> {
        this.requests.push(structuredClone({ ...request, onTextDelta: undefined }))
        return this.#inner.complete(request)
    }
}

interface Harness {
    runtime: RuntimeBundle
    instance: InstanceRuntime
    adapter: JingjingGameAdapter
    clock: ManualClock
    provider: RecordingProvider
}

function open(dbPath: string, seasonDir: string, startSim: number, instanceId?: string): Harness {
    const clock = new ManualClock(startSim)
    const provider = new RecordingProvider()
    const runtime = assembleRuntime({ dbPath, worldId: WORLD, template: jingjingTemplate, clock, provider,
        world: { enabled: true, worldIds: [WORLD], acceptObservations: true, allowedVerbs: [], allowedTargets: [] },
        configureInstance: (instance, context) => new JingjingGameAdapter({ instance, ...context, knowledge, seasonDir }),
    })
    const id = instanceId ?? runtime.identityService.resolveOrCreate('sillytavern', 'streamer', '主播').instance.id
    const instance = runtime.runtimeManager.get(id)
    return { runtime, instance, adapter: instance.extension as JingjingGameAdapter, clock, provider }
}

async function replay(h: Harness, steps: FixtureStep[]): Promise<void> {
    for (const step of steps) {
        h.clock.advance(10)
        const now = h.clock.nowSim()
        const base = { instanceId: h.instance.instanceId, kind: 'observation' as const, actionId: null, result: null, atWorldTimeMs: now }
        if ('snapshot' in step) {
            const { day, cash, investigation, items = [] } = step.snapshot
            const id = `ps:${step.label}:0`
            const facts = [
                { key: 'source', value: 'probably-stolen' }, { key: 'snapshotId', value: step.label }, { key: 'page', value: 0 },
                { key: 'pages', value: 1 }, { key: 'ready', value: true }, { key: 'capturedAt', value: now }, { key: 'cash', value: cash },
                { key: 'save', value: RUN }, { key: 'rent', value: 500 }, { key: 'day', value: day }, { key: 'investigation', value: investigation },
                { key: 'readerSession', value: 'reader-1' }, { key: 'readerSeq', value: 0 }, { key: 'readerFirstSeq', value: 1 },
                ...items.map((item, index) => ({ key: `item.${index}`, value: JSON.stringify(item) })),
            ]
            assert.deepEqual(h.runtime.world!.ingest(WORLD, [{ ...base, eventId: id, summary: '读取器快照', facts }]).rejected, [])
        } else {
            const facts = [{ key: 'source', value: 'probably-stolen' }, { key: 'event', value: step.event }, { key: 'runId', value: step.runId ?? RUN },
                ...Object.entries(step.facts ?? {}).map(([key, value]) => ({ key, value }))]
            assert.deepEqual(h.runtime.world!.ingest(WORLD, [{ ...base, eventId: `ps-event:${step.label}`, summary: `读取器事件 ${step.event}`, facts }]).rejected, [])
        }
        await h.runtime.runtimeManager.syncWorld(h.instance.instanceId)
    }
}

const steps = (...labels: string[]) => labels.map(label => SEASON_ONE_RUN.find(step => step.label === label)!)
const say = (h: Harness, text: string) => h.runtime.runtimeManager.send(h.instance, { identityKey: 'streamer', text }).then(() => h.runtime.runtimeManager.saveSnapshot(h.instance))
const beats = (h: Harness) => h.adapter.season.state().progress.map(record => record.beatId)
const tagged = (h: Harness, tag: string) => h.instance.workspace.memory.list({ tags: [tag], limit: 1e9 })
const coreState = (h: Harness) => { const s = h.adapter.season.state(); return { entered: s.entered, current: s.current, progress: s.progress, ended: s.ended } }

function auditInjected(provider: RecordingProvider): void {
    assert.ok(provider.requests.length > 0)
    for (const request of provider.requests) {
        const text = [request.system, ...request.messages.map(message => message.content)].join('\n')
        assert.deepEqual(findRecipeTerms(text), [], 'recipe terms must never reach the model context')
    }
}

test('script invariants: stance hints stay short and every beat has a world-event trigger', () => {
    const script = seasonOneScript({ ...SEASON_CONFIG, sayMyNameAchievementId: 'say_my_name' })
    for (const beat of script.beats) {
        assert.ok([...beat.stance].length <= MAX_STANCE_CHARS, beat.id)
        assert.ok((beat.trigger.any?.length ?? 0) + (beat.trigger.all?.length ?? 0) > 0, beat.id)
        assert.deepEqual(findRecipeTerms(beat.stance), [], beat.id)
    }
    assert.ok(script.beats.some(beat => beat.id === 'B9a'))
    assert.ok(!seasonOneScript(SEASON_CONFIG).beats.some(beat => beat.id === 'B9a'), 'unknown achievement ID keeps B9a disabled')
})

test('season one replay: beats, grudge book, accomplice ledger, spoiler gate, flags, review and restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cl-season-'))
    const dbPath = join(directory, 'cl.sqlite')
    const seasonDir = join(directory, 'season')
    let h = open(dbPath, seasonDir, 1000)
    const requests: LLMRequest[] = []
    try {
        // Prologue. Speech claims never move the script.
        await say(h, '我被抄了')
        assert.deepEqual(beats(h), [])
        await replay(h, steps('day1', 'early-heat'))
        assert.deepEqual(beats(h), ['B0'])
        assert.equal(h.adapter.season.state().runId, RUN)
        await say(h, '第3天前我一定让资金转正')
        await say(h, '第3天前我一定攒够房租')
        assert.equal(h.adapter.season.pendingFlags().length, 2)
        assert.equal(h.instance.workspace.motivation.commitments().filter(flag => flag.owner === 'user').length, 0)
        const before = coreState(h)
        await say(h, '我被抄了，治安官刚检查完，通过了')
        assert.deepEqual(coreState(h), before)
        assert.equal(tagged(h, 'accomplice').length, 0)

        // Close episode 1 and review through the files the streamer edits.
        await say(h, '结束本期')
        const pendingPath = join(seasonDir, 'review', 'EP01.pending.json')
        const pending = JSON.parse(readFileSync(pendingPath, 'utf8')) as PendingReviewFile
        assert.ok(pending.memories.length >= 3 && pending.memories.length <= 5)
        assert.equal(pending.flags.length, 2)
        for (const memory of pending.memories) assert.ok(memory.sourceRefs.length > 0)
        await say(h, '下一期还没审核')
        assert.equal(h.adapter.season.state().episodes.length, 1, 'next episode waits for the review')
        for (const item of pending.memories) item.decision = 'accept'
        for (const item of pending.flags) item.decision = 'accept'
        submitDecision(seasonDir, decisionsFromFile(pending))
        h.instance.extension!.sync()
        const flags = h.instance.workspace.motivation.open().filter(flag => flag.owner === 'user')
        assert.equal(flags.length, 2)
        for (const flag of flags) assert.equal(h.adapter.season.deadline(flag.id), 3)
        assert.ok(readdirSync(join(seasonDir, 'review', 'applied')).length === 1)

        // Episode 2 opens with the reviewed ledger from Memory and commitments only.
        await say(h, '开播了')
        const lastText = (provider: RecordingProvider) => provider.requests.at(-1)!.messages.map(message => message.content).join(' ')
        assert.match(lastText(h.provider), /第 2 期开场账本/)
        assert.match(lastText(h.provider), /上期摘要：本期节拍：B0/)
        await say(h, '继续')
        assert.doesNotMatch(lastText(h.provider), /开场账本/, 'the opening ledger is injected once per episode')

        // Act 1 and act 2 through world events; flags settle against Situation.
        await replay(h, steps('day2', 'scavenge', 'debt-free', 'chem-sale'))
        assert.deepEqual(beats(h), ['B0', 'B1', 'B2', 'B3'])
        const moneyFlag = h.instance.workspace.motivation.commitments().find(flag => flag.text.includes('资金转正'))!
        assert.equal(moneyFlag.status, 'kept')
        assert.equal(moneyFlag.evidenceRef, 'ps:debt-free:0')
        assert.equal(tagged(h, 'first_debt_free')[0]!.sourceRef, 'ps:debt-free:0')

        // Restart: state machine, commitments and memory restore without duplicate writes.
        const snapshotBefore = { season: h.adapter.season.state(), memories: h.instance.workspace.memory.list({ limit: 1e9 }).length,
            commitments: h.instance.workspace.motivation.commitments() }
        const instanceId = h.instance.instanceId
        const resumeAt = h.clock.nowSim()
        requests.push(...h.provider.requests)
        h.runtime.close()
        h = open(dbPath, seasonDir, resumeAt, instanceId)
        assert.deepEqual(h.adapter.season.state(), snapshotBefore.season)
        assert.deepEqual(h.instance.workspace.motivation.commitments(), snapshotBefore.commitments)
        assert.equal(h.instance.workspace.memory.list({ limit: 1e9 }).length, snapshotBefore.memories)
        await replay(h, steps('debt-free', 'chem-sale'))
        assert.deepEqual(beats(h), ['B0', 'B1', 'B2', 'B3'])
        assert.equal(h.instance.workspace.memory.list({ limit: 1e9 }).length, snapshotBefore.memories)

        // Act 3: heat, officer, inspection. Accomplice entries appear only after the inspection event.
        await replay(h, steps('heat-75', 'heat-80', 'officer'))
        assert.deepEqual(beats(h).slice(4), ['B4', 'B5'])
        assert.equal(tagged(h, 'accomplice').length, 0)
        await say(h, '刚才那个治安官太吓人了')
        await replay(h, steps('inspection'))
        const accomplice = tagged(h, 'accomplice')
        assert.equal(accomplice.length, 1)
        assert.equal(accomplice[0]!.sourceRef, 'ps-event:inspection')
        assert.ok(h.instance.workspace.relationship.milestones.some(milestone => milestone.evidence === 'ps-event:inspection'))

        // Grudge book: one attributable entry per kill event, from any run.
        assert.doesNotMatch(h.adapter.referenceData('cartel'), /涉及特殊来客/)
        await replay(h, steps('kill-1', 'story-other-run', 'kill-2'))
        assert.doesNotMatch(h.adapter.referenceData('cartel'), /涉及特殊来客/, 'a story seen in another run does not unlock this run')
        assert.ok(!h.adapter.season.state().entered.B8)
        await replay(h, steps('story'))
        assert.match(h.adapter.referenceData('cartel'), /涉及特殊来客/)
        const grudges = tagged(h, 'grudge')
        const kills = SEASON_ONE_RUN.filter(step => 'event' in step && step.event === 'kill:ai_controlled').length
        assert.equal(grudges.length, kills)
        assert.deepEqual(grudges.map(memory => memory.sourceRef).sort(), ['ps-event:kill-1', 'ps-event:kill-2'])

        // Day 4 passes the deadline of the unmet rent flag; then the run ends in bankruptcy.
        await replay(h, steps('day4'))
        const rentFlag = h.instance.workspace.motivation.commitments().find(flag => flag.text.includes('房租'))!
        assert.equal(rentFlag.status, 'broken')
        assert.equal(rentFlag.evidenceRef, 'ps:day4:0')
        await replay(h, steps('bankrupt', 'after-end'))
        assert.deepEqual(beats(h), ['B0', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'BK', 'BK', 'B8', 'BX'])
        assert.deepEqual(h.adapter.season.state().ended, { kind: 'failure', beatId: 'BX', cause: 'bankrupt', ref: 'ps-event:bankrupt' })
        assert.ok(!h.adapter.season.state().entered.B9b)
        assert.ok(!h.adapter.season.state().entered.B7, 'no evidence-removal event, no B7')
        for (const memory of tagged(h, 'season')) assert.ok(memory.sourceRef, memory.title)

        // Closing review for episode 2.
        await say(h, '本期结束')
        const second = h.adapter.season.pendingReview()!
        assert.ok(second.memories.length >= 3 && second.memories.length <= 5)
        assert.deepEqual(h.instance.workspace.affordance.list('world'), [])
        requests.push(...h.provider.requests)
        auditInjected({ requests } as unknown as RecordingProvider)
    } finally {
        h.runtime.close()
        rmSync(directory, { recursive: true, force: true })
    }
})

test('injected world context redacts recipe terms even when game data carries them', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cl-season-audit-'))
    const h = open(join(directory, 'cl.sqlite'), join(directory, 'season'), 1000)
    try {
        await replay(h, steps('day1', 'debt-free'))
        assert.ok(String(h.instance.workspace.situation.current().facts['itemName.reducer']).length > 0)
        await say(h, '现在店里有什么货？')
        assert.deepEqual(findRecipeTerms(h.adapter.contextData()), [])
        assert.deepEqual(findRecipeTerms(h.adapter.worldContext()), [])
        auditInjected(h.provider)
    } finally {
        h.runtime.close()
        rmSync(directory, { recursive: true, force: true })
    }
})

test('season binds to its run: events from another run neither open nor advance it', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'cl-season-run-'))
    const h = open(join(directory, 'cl.sqlite'), join(directory, 'season'), 1000)
    try {
        await replay(h, steps('day1'))
        await replay(h, [{ label: 'other-sale', event: 'sale:dream_dust', facts: { price: 400, profit: 300 }, runId: OTHER_RUN }])
        assert.deepEqual(beats(h), ['B0'])
    } finally {
        h.runtime.close()
        rmSync(directory, { recursive: true, force: true })
    }
})
