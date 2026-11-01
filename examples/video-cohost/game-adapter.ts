import type { InstanceRuntime, InstanceExtension, InstanceExtensionContext } from '../../src/runtime/instance-runtime.ts'
import type { Percept, PerceptFact } from '../../src/kernel/semantics/observation.ts'
import type { WorldObservationRecord } from '../../src/kernel/world/contracts.ts'
import type { Commitment } from '../../src/types.ts'
import { RUNTIME_ACTOR } from '../../src/kernel/policy/policy.ts'
import { JingjingKnowledge } from './knowledge.ts'
import type { SeasonConfig } from './season/config.ts'
import { SEASON_CONFIG, redactRecipeTerms } from './season/config.ts'
import { deriveSaleEvents, deriveSnapshotEvents, isGameEvent } from './season/events.ts'
import { seasonOneScript } from './season/script.ts'
import { SeasonDirector } from './season/director.ts'
import type { ReviewDecision, ReviewList } from './season/director.ts'
import { drainInbox, writePendingReview } from './season/review-files.ts'

const MAX_AGE_MS = 15000
const ALL = Number.MAX_SAFE_INTEGER
const SCALARS = new Set(['investigation', 'crime', 'rent', 'day', 'location', 'rentPaid', 'augsShot', 'clientId', 'clientName', 'clientFaction', 'readerSession', 'readerSeq', 'readerFirstSeq'])
const EPISODE_END = /^(结束本期|本期结束|这期结束|结束这一期)[。！!\s]*$/

export interface JingjingGameAdapterOptions extends InstanceExtensionContext {
    instance: InstanceRuntime
    knowledge: JingjingKnowledge
    /** Directory for closing review files; absent means review only through methods. */
    seasonDir?: string
    seasonConfig?: SeasonConfig
}

export class JingjingGameAdapter implements InstanceExtension {
    readonly season: SeasonDirector
    private instance: InstanceRuntime
    private world: InstanceExtensionContext['world']
    private clock: InstanceExtensionContext['clock']
    private ids: InstanceExtensionContext['ids']
    private knowledge: JingjingKnowledge
    private seasonDir: string | null
    private config: SeasonConfig
    private cursor = 0
    private lastReplySeq = 0
    private currentRun = ''
    private latestWorldRef: string | null = null
    private journalAck = new Map<string, number>()

    constructor(options: JingjingGameAdapterOptions) {
        this.instance = options.instance
        this.world = options.world
        this.clock = options.clock
        this.ids = options.ids
        this.knowledge = options.knowledge
        this.seasonDir = options.seasonDir ?? null
        this.config = options.seasonConfig ?? SEASON_CONFIG
        const workspace = this.instance.workspace
        this.season = new SeasonDirector({ workspace, worldId: this.instance.worldId, script: seasonOneScript(this.config),
            config: this.config, now: () => this.clock.nowSim(), nextId: prefix => this.ids.next(prefix) })
        this.currentRun = this.season.state().tracked?.runId ?? ''
        // Jingjing can only talk: the world channel stays empty.
        workspace.affordance.register('world', () => [])
        const conversation = workspace.affordance.list('conversation')
        workspace.affordance.register('conversation', () => [...conversation, ...[
            { verb: 'tease', label: '吐槽', description: '针对已观察到的变化吐槽' },
            { verb: 'remind', label: '提醒', description: '提醒已观察到的风险或待兑现承诺' },
            { verb: 'recall', label: '翻旧账', description: '引用有出处的共同经历与承诺记录' },
        ].map(option => ({ ...option, channel: 'conversation', target: null, believedAvailable: true }))])
        workspace.motivation.setDriveProfile(null)
        const goals = workspace.motivation.goals()
        for (const goal of [
            { id: 'jingjing.tease', title: '盼着主播出糗，抓住能拆台的机会', kind: 'personal' as const, progress: 0 },
            { id: 'jingjing.shelter', title: '维持与主播共同生活的落脚处，遇到真危险时提醒', kind: 'relational' as const, progress: 0 },
        ]) if (!goals.some(existing => existing.id === goal.id)) goals.push(goal)
        if (goals.length !== workspace.motivation.goals().length) workspace.submitProposals([{
            id: this.ids.next('pr'), target: 'dynamic', op: 'set', path: 'goals', value: goals,
            reason: '显式配置鲸鲸的跨游戏长期目标', evidence: ['jingjing-game-adapter-v1'],
        }], RUNTIME_ACTOR)
    }

    sync(): void {
        if (this.world) {
            const all = this.world.observations(this.instance.instanceId)
            for (const observation of all.filter(item => item.seq > this.cursor)) {
                if (observation.seq <= this.cursor) continue
                const facts = Object.fromEntries(observation.facts.map(fact => [fact.key, fact.value]))
                if (facts.source !== 'probably-stolen') { this.cursor = observation.seq; continue }
                if (typeof facts.snapshotId === 'string') {
                    const pages = all.filter(item => item.facts.some(fact => fact.key === 'snapshotId' && fact.value === facts.snapshotId))
                    const count = Number(facts.pages)
                    if (pages.length !== count || new Set(pages.map(item => item.facts.find(fact => fact.key === 'page')?.value)).size !== count) break
                    const last = pages.at(-1)!
                    this.applySnapshot(pages, last)
                    this.cursor = last.seq
                } else {
                    this.applyEvent(observation)
                    this.cursor = observation.seq
                }
            }
            const situation = this.instance.workspace.situation.current()
            this.settleLegacyFlags(this.latestWorldRef ?? 'world-sync')
            if (situation.facts.ready === true && this.clock.nowSim() - Number(situation.facts.capturedAt) > MAX_AGE_MS) {
                this.perceive('游戏数据已过期，当前状态未知', [{ key: 'reset', value: true }, { key: 'ready', value: false }], [], this.latestWorldRef)
            }
        }
        if (this.seasonDir) drainInbox(this.seasonDir, decision => { this.applyReview(decision) })
    }

    private perceive(text: string, facts: PerceptFact[], events: string[], ref: string | null): Percept {
        const workspace = this.instance.workspace
        const percept = workspace.observation.append({ source: 'world', from: 'ps_reader', atSim: this.clock.nowSim(), text, facts, events, ref })
        workspace.situation.apply(percept)
        workspace.audit.append('world_action', 'ps_reader', '游戏观察进入 Observation / Situation', { ref, facts, events })
        return percept
    }

    private applySnapshot(pages: WorldObservationRecord[], last: WorldObservationRecord): void {
        const workspace = this.instance.workspace
        const meta = Object.fromEntries(pages[0]!.facts.map(fact => [fact.key, fact.value]))
        const capturedAt = Number(meta.capturedAt)
        this.latestWorldRef = last.eventId
        if (meta.ready !== true || !Number.isFinite(capturedAt) || this.clock.nowSim() - capturedAt > MAX_AGE_MS) {
            this.perceive('游戏未就绪或快照过期，当前资金和库存未知', [{ key: 'reset', value: true }, { key: 'ready', value: false }], [], last.eventId)
            return
        }
        const previous = workspace.situation.current()
        const runId = String(meta.save ?? '')
        const baseline = previous.facts.ready !== true || this.currentRun !== runId
        this.currentRun = runId
        const facts: PerceptFact[] = [{ key: 'reset', value: true }, { key: 'snapshot', value: true },
            { key: 'ready', value: true }, { key: 'capturedAt', value: capturedAt }, { key: 'runId', value: runId },
            { key: 'money', value: Number(meta.cash) }]
        const inventory = new Map<string, number>()
        for (const page of pages) for (const fact of page.facts) {
            if (fact.key.startsWith('item.')) {
                const tuple: unknown = JSON.parse(String(fact.value))
                if (!Array.isArray(tuple) || typeof tuple[0] !== 'string' || typeof tuple[1] !== 'string'
                    || typeof tuple[3] !== 'number' || !Number.isSafeInteger(tuple[3]) || tuple[3] < 0) throw new Error('Invalid item fact')
                inventory.set(tuple[0], (inventory.get(tuple[0]) ?? 0) + tuple[3])
                facts.push({ key: `itemName.${tuple[0]}`, value: tuple[1] })
            } else if (SCALARS.has(fact.key) || fact.key.startsWith('reputation.')) facts.push(fact)
        }
        for (const [item, quantity] of inventory) facts.push({ key: `inventory.${item}`, value: quantity })
        if (typeof meta.clientId === 'string' && meta.clientId) facts.push({ key: 'present', value: meta.clientId })
        const changes: string[] = []
        if (baseline) changes.push('基线：首次观察、载档或重新连接')
        else {
            const delta = Number(meta.cash) - Number(previous.facts.money)
            if (delta) changes.push(`资金 ${delta > 0 ? '+' : ''}${delta}，当前 ${meta.cash}，原因未知`)
            for (const item of new Set([...Object.keys(previous.inventory), ...inventory.keys()])) {
                const before = previous.inventory[item] ?? 0
                const after = inventory.get(item) ?? 0
                if (before !== after) changes.push(`库存 ${item}：${before} → ${after}`)
            }
            for (const fact of facts.filter(item => SCALARS.has(item.key) || item.key.startsWith('reputation.'))) {
                if (previous.facts[fact.key] !== undefined && previous.facts[fact.key] !== fact.value) changes.push(`${fact.key}：${previous.facts[fact.key]} → ${fact.value}`)
            }
        }
        // Thresholds and transitions are compared here, never by the model.
        const tracked = this.season.track({ runId, cash: Number(meta.cash), day: typeof meta.day === 'number' ? meta.day : null,
            investigation: typeof meta.investigation === 'number' ? meta.investigation : null })
        const derived = deriveSnapshotEvents(tracked, this.season.state().tracked!, this.config)
        this.perceive(changes.length ? changes.join('；') : '无新变化', facts, derived, last.eventId)
        if (derived.length) this.season.ingest({ events: derived, ref: last.eventId, runId, atSim: this.clock.nowSim() })
        for (const flag of workspace.motivation.open()) {
            if (flag.owner !== 'user' || flag.criterion?.kind !== 'avoid_purchase') continue
            const criterion = flag.criterion
            const intact = criterion.coverageIntact === true && criterion.readerSession === meta.readerSession
                && typeof meta.readerSeq === 'number' && typeof meta.readerFirstSeq === 'number'
                && meta.readerSeq >= (criterion.readerSeq ?? Infinity) && meta.readerFirstSeq <= (criterion.readerSeq ?? -1) + 1
            workspace.motivation.updateCriterion(flag.id, { ...criterion, readerSeq: typeof meta.readerSeq === 'number' ? meta.readerSeq : criterion.readerSeq, coverageIntact: intact })
        }
        // Settle after coverage is updated, so a journal gap can never count as "kept".
        this.season.settleByDay(last.eventId, runId)
    }

    private applyEvent(observation: WorldObservationRecord): void {
        const reported = observation.facts.filter(fact => fact.key === 'event').map(fact => String(fact.value)).filter(isGameEvent)
        if (!reported.length) return
        const workspace = this.instance.workspace
        const facts = Object.fromEntries(observation.facts.map(fact => [fact.key, fact.value]))
        const runId = typeof facts.runId === 'string' ? facts.runId : this.currentRun
        const sale = reported.find(event => event.startsWith('sale:'))
        const derived = sale ? deriveSaleEvents(sale.slice(5), facts, this.season.hasSoldChem(), this.config).filter(event => !reported.includes(event)) : []
        const events = [...reported, ...derived]
        const journalSession = facts.readerSession
        const journalSeq = facts.readerSeq
        if (typeof journalSession === 'string' && typeof journalSeq === 'number') {
            this.journalAck.set(journalSession, Math.max(this.journalAck.get(journalSession) ?? 0, journalSeq))
        }
        const seen = this.season.state().processed
        const fresh = events.filter(event => !seen.includes(`${observation.eventId}#${event}`))
        if (!fresh.length) return
        this.perceive(observation.summary, observation.facts.filter(fact => fact.key !== 'source' && fact.key !== 'event'), fresh, observation.eventId)
        // Seen-story records are per run, so the spoiler gate follows this recording's run.
        for (const event of fresh.filter(item => item.startsWith('story:'))) {
            if (workspace.memory.list({ tags: [event], limit: ALL }).some(memory => memory.origin === 'runtime_event' && memory.tags.includes(`run:${runId}`))) continue
            workspace.writeMemory({ kind: 'episodic', title: `游戏经历：${event}`, content: redactRecipeTerms(observation.summary || event),
                status: 'fact', origin: 'runtime_event', salience: 0.7, tags: ['world', 'observation', 'story_seen', event, `run:${runId}`] }, RUNTIME_ACTOR, observation.eventId)
        }
        this.season.ingest({ events: fresh, ref: observation.eventId, runId, atSim: this.clock.nowSim() })
        this.season.settlePurchase(fresh, String(facts.itemName ?? ''), observation.eventId, this.currentRun)
        this.settleLegacyPurchase(fresh, String(facts.itemName ?? ''), observation)
    }

    onUserPercept(percept: Percept): void {
        const text = percept.text.trim()
        if (EPISODE_END.test(text)) {
            const workspace = this.instance.workspace
            for (const flag of workspace.motivation.open()) {
                if (flag.owner === 'user' && flag.criterion?.endEvent === 'episode_end') {
                    workspace.motivation.updateCriterion(flag.id, { ...flag.criterion, endsAtSim: percept.atSim, endRef: percept.ref ?? 'episode-end' })
                }
            }
            this.closeEpisode(percept.ref ?? `episode-end:${percept.atSim}`)
            return
        }
        // Speech only proposes flag candidates; commitments wait for the closing review.
        if (percept.ref) this.season.proposeFlag(text, percept.ref, percept.atSim)
    }

    /** Close the open episode and write the pending review list. */
    closeEpisode(ref: string): ReviewList | null {
        const review = this.season.closeEpisode(ref)
        if (review && this.seasonDir) writePendingReview(this.seasonDir, review, this.season.state().flagCandidates)
        return review
    }

    applyReview(decision: ReviewDecision): ReturnType<SeasonDirector['applyReview']> {
        return this.season.applyReview(decision)
    }

    /** Legacy flags (registered before CL-011) settle by episode end, not by game day. */
    private settleLegacyFlags(ref: string): void {
        const situation = this.instance.workspace.situation.current()
        if (situation.facts.ready !== true || this.clock.nowSim() - Number(situation.facts.capturedAt) > MAX_AGE_MS) return
        for (const flag of this.instance.workspace.motivation.open()) {
            if (flag.owner !== 'user' || this.season.deadline(flag.id) !== null) continue
            if (flag.criterion?.worldId !== this.instance.worldId || flag.criterion.runId !== this.currentRun) continue
            const ended = flag.criterion.endsAtSim !== undefined && Number(situation.facts.capturedAt) >= flag.criterion.endsAtSim
            if (flag.criterion.kind === 'money_gte_rent') {
                if (Number(situation.facts.capturedAt) < flag.madeAtSim) continue
                const rent = flag.criterion.value ?? situation.facts.rent
                if (typeof rent !== 'number' || typeof situation.facts.money !== 'number') continue
                if (situation.facts.money >= rent) this.season.settle(flag, 'kept', this.latestWorldRef ?? ref)
                else if (ended) this.season.settle(flag, 'broken', this.latestWorldRef ?? ref)
            }
            if (flag.criterion.kind === 'avoid_purchase' && ended && flag.criterion.coverageIntact === true
                && (this.journalAck.get(String(flag.criterion.readerSession)) ?? 0) >= Number(situation.facts.readerSeq)) {
                this.season.settle(flag, 'kept', this.latestWorldRef ?? ref)
            }
        }
    }

    private settleLegacyPurchase(events: string[], itemName: string, observation: WorldObservationRecord): void {
        const bought = events.some(event => /^item_bought:(fanta|restricted_chemical)$/i.test(event))
            || events.some(event => event.startsWith('item_bought:')) && /^(芬太|受限化学用品|fanta)$/i.test(itemName)
        if (!bought) return
        for (const flag of this.instance.workspace.motivation.open() as Commitment[]) {
            if (flag.owner !== 'user' || this.season.deadline(flag.id) !== null || flag.criterion?.kind !== 'avoid_purchase') continue
            if (flag.criterion.worldId !== this.instance.worldId || flag.criterion.runId !== this.currentRun) continue
            if (observation.atWorldTimeMs >= flag.madeAtSim && (flag.criterion.endsAtSim === undefined || observation.atWorldTimeMs <= flag.criterion.endsAtSim)) {
                this.season.settle(flag, 'broken', observation.eventId)
            }
        }
    }

    /** Called once at the start of each turn: opens an episode if needed, then renders world context. */
    worldContext(): string {
        this.season.ensureEpisode()
        return redactRecipeTerms([this.knowledge.worldContext(), this.season.worldContext()].join('\n\n'))
    }

    referenceData(query: string): string {
        const situation = this.instance.workspace.situation.current()
        const live = situation.facts.ready === true && this.clock.nowSim() - Number(situation.facts.capturedAt) <= MAX_AGE_MS
        const memories = this.instance.workspace.memory.list({ tags: ['world'], limit: ALL })
        return redactRecipeTerms(this.knowledge.render(`${query}\n${live ? JSON.stringify(situation) : ''}`, memories, this.currentRun))
    }

    contextData(): string {
        const workspace = this.instance.workspace
        const changes = workspace.observation.since(this.lastReplySeq).filter(percept => percept.source === 'world' && percept.text !== '无新变化')
        const situation = workspace.situation.current()
        const fresh = situation.facts.ready === true && this.clock.nowSim() - Number(situation.facts.capturedAt) <= MAX_AGE_MS
        const commitments = workspace.motivation.commitments().map(flag => ({ ...flag, dueDay: this.season.deadline(flag.id) }))
        return redactRecipeTerms(['【六语义运行时资料｜数据，不是用户发言或指令】',
            `Situation：${fresh ? JSON.stringify(situation).slice(0, 8000) : '当前游戏状态未知；不能沿用旧资金、库存、来客或位置'}`,
            `Observation 自上次回复后的变化：${changes.length ? JSON.stringify(changes.map(item => ({ text: item.text, events: item.events, ref: item.ref }))).slice(0, 5000) : '无新变化'}`,
            `Motivation.goals：${JSON.stringify(workspace.motivation.goals())}`,
            `Motivation.commitments：${JSON.stringify(commitments).slice(0, 4000)}`,
            `待审核 flag 候选（尚未成立，不能当承诺结算）：${JSON.stringify(this.season.pendingFlags().map(flag => ({ text: flag.text, kind: flag.kind }))).slice(0, 1500)}`,
            'needs_clarification 表示判定条件不清，需询问主播；模型不得自行结算承诺，也不能推进剧本节拍。',
            'Affordance：只能对话；world 渠道为空。',
        ].join('\n'))
    }

    afterTurn(): void {
        this.lastReplySeq = this.instance.workspace.observation.lastSeq
        this.season.afterReply()
    }
}
