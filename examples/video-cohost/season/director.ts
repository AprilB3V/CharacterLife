/**
 * Season director: the beat state machine, flag ledger and episode bookkeeping.
 *
 * - Beats advance only from world events (reader observations or adapter-derived
 *   transitions). Conversation text can neither advance nor rewind them.
 * - State lives in the instance (`workspace.setExtensionState`) and is persisted with
 *   the instance snapshot, so a restart resumes without duplicate writes.
 * - Every progression writes Memory or a milestone carrying the triggering world ref.
 */
import type { CharacterWorkspace } from '../../../src/runtime/workspace.ts'
import type { Commitment, MemoryEntry } from '../../../src/types.ts'
import type { MemoryWriteInput } from '../../../src/kernel/memory/store.ts'
import { RUNTIME_ACTOR } from '../../../src/kernel/policy/policy.ts'
import type { SeasonConfig } from './config.ts'
import { redactRecipeTerms } from './config.ts'
import type { TrackedScalars } from './events.ts'
import type { BeatDef, SeasonScript } from './script.ts'
import { triggerMatches, validateScript } from './script.ts'

const STATE_KEY = 'jingjing.season'
const MAX_PROCESSED = 5000
const ALL = Number.MAX_SAFE_INTEGER

export type FlagKind = 'money_gte' | 'money_gte_rent' | 'avoid_purchase'

export interface FlagCandidate {
    id: string
    text: string
    sourceRef: string
    episode: number
    atSim: number
    kind: FlagKind | 'needs_clarification'
    value?: number
    target?: string
    dueDay?: number
    status: 'pending' | 'accepted' | 'rejected'
}

export interface MemoryCandidate {
    id: string
    title: string
    content: string
    sourceRefs: string[]
    tags: string[]
}

export interface ReviewList {
    reviewId: string
    episode: number
    createdAtSim: number
    memories: MemoryCandidate[]
    flags: string[]
}

export interface ReviewDecision {
    reviewId: string
    memories?: Array<{ id: string; decision: 'accept' | 'reject' }>
    flags?: Array<{ id: string; decision: 'accept' | 'reject'; dueDay?: number; value?: number }>
}

interface EpisodeState {
    n: number
    openedAtSim: number
    opening: string
    openingDelivered: boolean
    closedAtSim: number | null
    closeRef: string | null
    cashAtOpen: number | null
    review: ReviewList | null
    reviewApplied: boolean
}

interface ProgressRecord {
    beatId: string
    ref: string
    events: string[]
    atSim: number
    episode: number
}

interface SeasonState {
    version: 1
    scriptId: string
    runId: string | null
    entered: Record<string, { firstRef: string; count: number }>
    current: string | null
    transient: string | null
    ended: { kind: 'success' | 'failure'; beatId: string; cause: string | null; ref: string } | null
    processed: string[]
    tracked: TrackedScalars | null
    chemSold: boolean
    progress: ProgressRecord[]
    episodes: EpisodeState[]
    flagCandidates: FlagCandidate[]
    reportedSettlements: string[]
    /** Game-day deadlines per commitment ID; kept here because the kernel criterion has no day field. */
    flagDeadlines: Record<string, number>
    flagSeq: number
}

export interface GameEventInput {
    events: string[]
    ref: string
    runId: string
    atSim: number
}

function emptyState(scriptId: string): SeasonState {
    return { version: 1, scriptId, runId: null, entered: {}, current: null, transient: null, ended: null, processed: [],
        tracked: null, chemSold: false, progress: [], episodes: [], flagCandidates: [], reportedSettlements: [], flagDeadlines: {}, flagSeq: 0 }
}

export class SeasonDirector {
    readonly script: SeasonScript
    readonly config: SeasonConfig
    private workspace: CharacterWorkspace
    private worldId: string
    private now: () => number
    private nextId: (prefix: string) => string

    constructor(options: { workspace: CharacterWorkspace; worldId: string; script: SeasonScript; config: SeasonConfig;
        now: () => number; nextId: (prefix: string) => string }) {
        validateScript(options.script)
        this.script = options.script
        this.config = options.config
        this.workspace = options.workspace
        this.worldId = options.worldId
        this.now = options.now
        this.nextId = options.nextId
    }

    /* ------------------------------------------------------------ state */

    state(): SeasonState {
        const stored = this.workspace.extensionState<SeasonState>(STATE_KEY)
        return stored && stored.scriptId === this.script.id ? stored : emptyState(this.script.id)
    }

    private save(state: SeasonState): void {
        if (state.processed.length > MAX_PROCESSED) state.processed.splice(0, state.processed.length - MAX_PROCESSED)
        this.workspace.setExtensionState(STATE_KEY, state)
    }

    private episode(state: SeasonState): EpisodeState | null {
        const last = state.episodes.at(-1)
        return last && last.closedAtSim === null ? last : null
    }

    private episodeNumber(state: SeasonState): number {
        return this.episode(state)?.n ?? state.episodes.length + 1
    }

    /** Remember the last reader scalars; returns the previous value for transition derivation. */
    track(next: TrackedScalars): TrackedScalars | null {
        const state = this.state()
        const previous = state.tracked
        state.tracked = next
        // An episode opened before the reader connected takes its opening cash from the first snapshot.
        const episode = this.episode(state)
        if (episode && episode.cashAtOpen === null) episode.cashAtOpen = next.cash
        this.save(state)
        return previous
    }

    hasSoldChem(): boolean { return this.state().chemSold }

    /* ------------------------------------------------------------ beats */

    /** Feed world events from one observation. Returns the beats entered. */
    ingest(input: GameEventInput): string[] {
        const state = this.state()
        const fresh = input.events.filter(event => !state.processed.includes(`${input.ref}#${event}`))
        if (!fresh.length) return []
        for (const event of fresh) state.processed.push(`${input.ref}#${event}`)
        if (fresh.some(event => event.startsWith('sale:') && this.config.chemItemIds.includes(event.slice(5)))) state.chemSold = true
        const entered: string[] = []
        // A season is bound to the run that opened it; other runs never move it.
        const runMatches = state.runId === null || state.runId === input.runId
        for (const beat of this.script.beats) {
            if (!beat.crossCutting && (state.ended || !runMatches)) continue
            {
                const already = state.entered[beat.id]
                if (already && !beat.repeatable) continue
                if (!beat.requires.every(id => state.entered[id])) continue
                const matched = triggerMatches(beat.trigger, fresh)
                if (!matched) continue
                this.enter(state, beat, matched, input)
                entered.push(beat.id)
            }
        }
        this.save(state)
        return entered
    }

    private enter(state: SeasonState, beat: BeatDef, events: string[], input: GameEventInput): void {
        const first = !state.entered[beat.id]
        state.entered[beat.id] = { firstRef: state.entered[beat.id]?.firstRef ?? input.ref, count: (state.entered[beat.id]?.count ?? 0) + 1 }
        const active = state.runId !== null && !state.ended && (state.runId === input.runId)
        if (beat.transient) { if (active || !beat.crossCutting) state.transient = beat.id }
        else state.current = beat.id
        state.progress.push({ beatId: beat.id, ref: input.ref, events, atSim: input.atSim, episode: this.episodeNumber(state) })
        if (first) {
            this.remember({ kind: 'episodic', title: `剧本推进：${beat.id} ${beat.title}`,
                content: `${beat.actTitle}·${beat.title}；触发事件 ${events.join('、')}；出处 ${input.ref}`,
                status: 'fact', origin: 'runtime_event', salience: 0.5,
                tags: ['season', 'season_progress', `beat:${beat.id}`, `run:${input.runId}`] }, input.ref, `beat:${beat.id}`)
        }
        this.workspace.audit.append('decision', 'runtime', `剧本节拍 ${beat.id} 由世界事件触发`, { beatId: beat.id, events, ref: input.ref })
        for (const effect of beat.effects) this.applyEffect(state, beat, effect, events, input)
    }

    private applyEffect(state: SeasonState, beat: BeatDef, effect: BeatDef['effects'][number], events: string[], input: GameEventInput): void {
        const run = `run:${input.runId}`
        switch (effect) {
            case 'open_season':
                state.runId = input.runId
                return
            case 'first_debt_free':
                this.remember({ kind: 'episodic', title: '里程碑：第一次不欠钱', content: `资金第一次从赤字回到非负；世界证据 ${input.ref}`,
                    status: 'fact', origin: 'runtime_event', salience: 0.8, tags: ['season', 'milestone', 'first_debt_free', run] }, input.ref, 'first_debt_free')
                return
            case 'open_accomplice_line':
                this.remember({ kind: 'episodic', title: '共犯线开启', content: `化学品首次高利润卖出，鲸鲸从冤家转为账房共犯；世界证据 ${input.ref}`,
                    status: 'fact', origin: 'runtime_event', salience: 0.8, tags: ['season', 'accomplice_line', run] }, input.ref, 'accomplice_line')
                return
            case 'accomplice_milestone': {
                const written = this.remember({ kind: 'episodic', title: '共犯账：躲过治安部', content: `${events.join('、')}；世界证据 ${input.ref}`,
                    status: 'fact', origin: 'runtime_event', salience: 0.8, tags: ['season', 'accomplice', run] }, input.ref, 'accomplice')
                if (written) this.workspace.recordMilestone('shared_experience', '共犯：一起躲过治安部', input.ref)
                return
            }
            case 'grudge_entry':
                this.remember({ kind: 'episodic', title: '记仇本：被控制者被击杀', content: `主播除掉一名被 AI 控制的人，鲸鲸记了一笔；世界证据 ${input.ref}`,
                    status: 'fact', origin: 'runtime_event', salience: 0.7, tags: ['season', 'grudge', 'kill:ai_controlled', run] }, input.ref, 'grudge')
                return
            case 'story_seen':
                // Story memories themselves are written by the adapter for every story event.
                return
            case 'season_success':
            case 'season_failure': {
                const kind = effect === 'season_success' ? 'success' : 'failure'
                const cause = events.find(event => event.startsWith('game_over:'))?.slice('game_over:'.length) ?? null
                state.ended = { kind, beatId: beat.id, cause, ref: input.ref }
                this.remember({ kind: 'episodic', title: kind === 'success' ? `季终：${beat.title}` : '季终：完蛋',
                    content: `${this.seasonTally(state)}${cause ? `；失败原因 ${cause}` : ''}；世界证据 ${input.ref}`,
                    status: 'fact', origin: 'runtime_event', salience: 0.9, tags: ['season', 'season_end', kind, run] }, input.ref, 'season_end')
                return
            }
        }
    }

    private seasonTally(state: SeasonState): string {
        const grudges = this.memories(['grudge']).filter(memory => memory.tags.includes(`run:${state.runId}`)).length
        const accomplice = this.memories(['accomplice']).filter(memory => memory.tags.includes(`run:${state.runId}`)).length
        const beats = Object.keys(state.entered).join('、')
        return `本季节拍 ${beats || '无'}；记仇本 ${grudges} 条；共犯账 ${accomplice} 条`
    }

    /** Write Memory once per (sourceRef, tag); repeated replays never duplicate it. */
    private remember(input: MemoryWriteInput, ref: string, dedupTag: string): boolean {
        const tags = [...new Set([...(input.tags ?? []), dedupTag])]
        if (this.workspace.memory.list({ includeDeleted: true, limit: ALL }).some(memory => memory.sourceRef === ref && memory.tags.includes(dedupTag))) return false
        const content = redactRecipeTerms(input.content)
        return this.workspace.writeMemory({ ...input, content, tags }, RUNTIME_ACTOR, ref).written
    }

    private memories(tags: string[]): MemoryEntry[] {
        return this.workspace.memory.list({ tags, limit: ALL }).filter(memory => memory.origin === 'runtime_event' && memory.sourceRef)
    }

    /** Clear the transient stance once a reply has used it. */
    afterReply(): void {
        const state = this.state()
        const episode = this.episode(state)
        if (!state.transient && (!episode || episode.openingDelivered)) return
        state.transient = null
        if (episode) episode.openingDelivered = true
        this.save(state)
    }

    /* ------------------------------------------------------------ flags */

    /** Rules propose candidates only; commitments are written after the closing review. */
    proposeFlag(text: string, sourceRef: string, atSim: number): FlagCandidate | null {
        const clean = text.trim()
        if (/[?？“”「」]|比如|假如|如果|他说|她说|上期|上次|之前|已经/.test(clean)) return null
        const dueMatch = clean.match(/第\s*(\d{1,4})\s*天(?:前|之前|以前|内|结束前)/)
        const dueDay = dueMatch ? Number(dueMatch[1]) : undefined
        let candidate: Omit<FlagCandidate, 'id' | 'text' | 'sourceRef' | 'episode' | 'atSim' | 'status'> | null = null
        if (/(资金|钱|账)\s*(转正|回正|不欠|还清)|(还清|不再欠).*(钱|债|账)/.test(clean) && /(一定|保证|必须|肯定|发誓)/.test(clean)) {
            candidate = { kind: 'money_gte', value: 0, ...(dueDay !== undefined ? { dueDay } : {}) }
        } else if (/(一定|保证|必须|肯定|发誓).*(攒够|赚够|凑够).*房租/.test(clean)) {
            candidate = { kind: 'money_gte_rent', ...(dueDay !== undefined ? { dueDay } : {}) }
        } else if (/(再也不|不再|保证不|绝不).*(买|购入).*(芬太|fanta|restricted_chemical)/i.test(clean)) {
            candidate = { kind: 'avoid_purchase', target: 'fanta', ...(dueDay !== undefined ? { dueDay } : {}) }
        } else if (/(再也不|不再|保证不|绝不).*碰.*(芬太|fanta)/i.test(clean)) {
            // "Touch" does not identify purchase, possession or use: game data cannot judge it.
            candidate = { kind: 'needs_clarification' }
        }
        if (!candidate) return null
        const state = this.state()
        if (state.flagCandidates.some(item => item.sourceRef === sourceRef || item.status === 'pending' && item.text === clean)) return null
        const flag: FlagCandidate = { id: `flagcand_${++state.flagSeq}`, text: clean, sourceRef, episode: this.episodeNumber(state), atSim, status: 'pending', ...candidate }
        state.flagCandidates.push(flag)
        this.save(state)
        this.workspace.audit.append('decision', 'runtime', '登记 flag 候选，待收尾审核', { candidate: flag })
        return flag
    }

    pendingFlags(): FlagCandidate[] { return this.state().flagCandidates.filter(item => item.status === 'pending') }

    /** Game-day deadline of an accepted flag, or null for legacy flags. */
    deadline(flagId: string): number | null {
        return this.state().flagDeadlines[flagId] ?? null
    }

    /** Settle open day-bounded flags against the current Situation. */
    settleByDay(ref: string, currentRun: string): void {
        const situation = this.workspace.situation.current()
        const day = situation.facts.day
        const money = situation.facts.money
        if (situation.facts.ready !== true || typeof day !== 'number') return
        const deadlines = this.state().flagDeadlines
        for (const flag of this.workspace.motivation.open()) {
            const criterion = flag.criterion
            const dueDay = deadlines[flag.id]
            if (flag.owner !== 'user' || !criterion || dueDay === undefined) continue
            if (criterion.worldId !== this.worldId || criterion.runId !== currentRun) continue
            if (criterion.kind === 'money_gte' || criterion.kind === 'money_gte_rent') {
                const target = criterion.kind === 'money_gte' ? criterion.value : criterion.value ?? situation.facts.rent
                if (typeof target !== 'number' || typeof money !== 'number') continue
                if (money >= target && day <= dueDay) this.settle(flag, 'kept', ref)
                else if (day > dueDay) this.settle(flag, 'broken', ref)
            } else if (criterion.kind === 'avoid_purchase' && day > dueDay && criterion.coverageIntact === true) {
                this.settle(flag, 'kept', ref)
            }
        }
    }

    /** Break day-bounded avoid-purchase flags on an actual purchase event inside the window. */
    settlePurchase(events: string[], itemName: string, ref: string, currentRun: string): void {
        const bought = events.some(event => /^item_bought:(fanta|restricted_chemical)$/i.test(event))
            || events.some(event => event.startsWith('item_bought:')) && /^(芬太|受限化学用品|fanta)$/i.test(itemName)
        if (!bought) return
        const day = this.workspace.situation.current().facts.day
        const deadlines = this.state().flagDeadlines
        for (const flag of this.workspace.motivation.open()) {
            const criterion = flag.criterion
            const dueDay = deadlines[flag.id]
            if (flag.owner !== 'user' || criterion?.kind !== 'avoid_purchase' || dueDay === undefined) continue
            if (criterion.worldId !== this.worldId || criterion.runId !== currentRun) continue
            if (typeof day === 'number' && day > dueDay) continue
            this.settle(flag, 'broken', ref)
        }
    }

    settle(flag: Commitment, status: 'kept' | 'broken', ref: string): void {
        if (!this.workspace.motivation.settle(flag.id, status, ref)) return
        this.remember({ kind: 'episodic', title: `Flag ${status === 'kept' ? '兑现' : '违约'}`,
            content: `${flag.text}；原承诺出处 ${flag.sourceRef}；世界证据 ${ref}`, status: 'fact', origin: 'runtime_event',
            salience: 0.85, tags: ['commitment', status] }, ref, `flag:${flag.id}`)
        this.workspace.recordMilestone(status === 'kept' ? 'promise_kept' : 'promise_broken', '游戏承诺由世界证据结算', `${flag.sourceRef} -> ${ref}`)
        this.workspace.audit.append('decision', 'runtime', '世界证据结算主播承诺', { flagId: flag.id, sourceRef: flag.sourceRef, evidenceRef: ref, status })
    }

    /* ------------------------------------------------------------ episodes */

    /** Open an episode on the first turn after the previous one closed. */
    ensureEpisode(): void {
        const state = this.state()
        if (this.episode(state)) return
        const previous = state.episodes.at(-1) ?? null
        if (previous && previous.review && !previous.reviewApplied) {
            // The opening must reflect the reviewed ledger; keep talking without a new episode until then.
            return
        }
        const n = state.episodes.length + 1
        state.episodes.push({ n, openedAtSim: this.now(), opening: this.buildOpening(state, previous), openingDelivered: false,
            closedAtSim: null, closeRef: null, cashAtOpen: state.tracked?.cash ?? null, review: null, reviewApplied: false })
        this.save(state)
        this.workspace.audit.append('decision', 'runtime', `第 ${n} 期开场`, { episode: n })
    }

    /** Opening ledger built only from Memory and commitments. */
    private buildOpening(state: SeasonState, previous: EpisodeState | null): string {
        const n = state.episodes.length + 1
        if (!previous) return `第 ${n} 期开场账本：第一期，还没有旧账可翻。`
        const since = previous.openedAtSim
        const lines = [`第 ${n} 期开场账本（来自 Memory 与 commitments，不得补编）：`]
        const summary = this.workspace.memory.list({ tags: [`episode:${previous.n}`], limit: ALL }).filter(memory => memory.tags.includes('episode_summary') && memory.tags.includes('reviewed'))
        lines.push(`- 上期摘要：${summary.length ? summary.map(memory => memory.content).join(' / ') : '上期没有通过审核的摘要'}`)
        const settled = this.workspace.motivation.commitments().filter(flag => flag.owner === 'user' && flag.status !== 'open'
            && !state.reportedSettlements.includes(flag.id))
        for (const flag of settled) state.reportedSettlements.push(flag.id)
        const day = this.workspace.situation.current().facts.day
        const due = this.workspace.motivation.open().filter(flag => flag.owner === 'user' && state.flagDeadlines[flag.id] !== undefined
            && typeof day === 'number' && state.flagDeadlines[flag.id]! <= day)
        lines.push(`- Flag：${[...settled.map(flag => `「${flag.text}」${flag.status === 'kept' ? '兑现' : '倒了'}（证据 ${flag.evidenceRef}）`),
            ...due.map(flag => `「${flag.text}」今天到期，尚未结算`)].join('；') || '没有结算或到期的 flag'}`)
        const grudges = this.memories(['grudge']).filter(memory => memory.createdAtSim >= since)
        lines.push(`- 记仇本新增：${grudges.length} 条${grudges.length ? `（出处 ${grudges.map(memory => memory.sourceRef).join('、')}）` : ''}`)
        const accomplice = this.memories(['accomplice']).filter(memory => memory.createdAtSim >= since)
        lines.push(`- 共犯里程碑：${accomplice.length} 条${accomplice.length ? `（出处 ${accomplice.map(memory => memory.sourceRef).join('、')}）` : ''}`)
        return lines.join('\n')
    }

    /** Close the open episode and produce the review list (3–5 candidates when material exists). */
    closeEpisode(ref: string): ReviewList | null {
        const state = this.state()
        const episode = this.episode(state)
        if (!episode) return null
        episode.closedAtSim = this.now()
        episode.closeRef = ref
        const progress = state.progress.filter(record => record.episode === episode.n)
        const reviewId = `EP${String(episode.n).padStart(2, '0')}`
        const memories: MemoryCandidate[] = []
        const firstTimes = progress.filter((record, index) => progress.findIndex(other => other.beatId === record.beatId) === index)
        const kills = progress.filter(record => record.beatId === 'BK').length
        const accomplice = progress.filter(record => record.beatId === 'B6').length
        const settledHere = this.workspace.motivation.commitments().filter(flag => flag.owner === 'user' && flag.status !== 'open'
            && !state.reportedSettlements.includes(flag.id))
        memories.push({ id: `${reviewId}-M1`, title: `第 ${episode.n} 期摘要`,
            content: `本期节拍：${firstTimes.map(record => `${record.beatId}`).join('、') || '无推进'}；记仇本 +${kills}；共犯账 +${accomplice}；`
                + `Flag 结算 ${settledHere.map(flag => `「${flag.text}」${flag.status === 'kept' ? '兑现' : '违约'}`).join('、') || '无'}`
                + `${state.ended ? `；本季已结束（${state.ended.kind === 'success' ? '成功' : '失败'}）` : ''}`,
            sourceRefs: [...new Set([...progress.map(record => record.ref), ref])], tags: ['episode_summary', `episode:${episode.n}`] })
        const cash = state.tracked?.cash
        if (typeof cash === 'number' && episode.cashAtOpen !== null && state.tracked) {
            memories.push({ id: `${reviewId}-M2`, title: `第 ${episode.n} 期账面`, content: `开场资金 ${episode.cashAtOpen}，收尾资金 ${cash}${state.tracked.day !== null ? `，游戏第 ${state.tracked.day} 天` : ''}`,
                sourceRefs: [ref], tags: ['episode_ledger', `episode:${episode.n}`] })
        }
        for (const record of firstTimes) {
            if (memories.length >= this.config.maxClosingMemories) break
            const beat = this.script.beats.find(item => item.id === record.beatId)
            if (!beat || beat.repeatable) continue
            memories.push({ id: `${reviewId}-M${memories.length + 1}`, title: `一起经历：${beat.title}`,
                content: `${beat.actTitle}·${beat.title}；触发事件 ${record.events.join('、')}`, sourceRefs: [record.ref], tags: ['shared_experience', `episode:${episode.n}`, `beat:${beat.id}`] })
        }
        const review: ReviewList = { reviewId, episode: episode.n, createdAtSim: this.now(), memories: memories.slice(0, this.config.maxClosingMemories),
            flags: state.flagCandidates.filter(flag => flag.status === 'pending').map(flag => flag.id) }
        episode.review = review
        this.save(state)
        this.workspace.audit.append('decision', 'runtime', `第 ${episode.n} 期收尾，生成待审核清单`, { reviewId, memories: review.memories.length, flags: review.flags.length })
        return structuredClone(review)
    }

    pendingReview(): ReviewList | null {
        const state = this.state()
        const episode = [...state.episodes].reverse().find(item => item.review && !item.reviewApplied)
        return episode?.review ? structuredClone(episode.review) : null
    }

    /**
     * Apply the streamer's decisions. Candidate text comes from the stored review,
     * never from the decision file; only accept/reject, due day and target value do.
     */
    applyReview(decision: ReviewDecision): { memories: number; flags: number; rejected: string[] } {
        const state = this.state()
        const episode = state.episodes.find(item => item.review?.reviewId === decision.reviewId)
        if (!episode?.review) throw new Error(`Unknown review ${decision.reviewId}`)
        if (episode.reviewApplied) return { memories: 0, flags: 0, rejected: [] }
        const rejected: string[] = []
        let memories = 0
        let flags = 0
        for (const item of decision.memories ?? []) {
            const candidate = episode.review.memories.find(memory => memory.id === item.id)
            if (!candidate) { rejected.push(`${item.id}: unknown candidate`); continue }
            if (item.decision !== 'accept') continue
            const written = this.remember({ kind: 'episodic', title: candidate.title, content: `${candidate.content}；出处 ${candidate.sourceRefs.join('、')}`,
                status: 'fact', origin: 'runtime_event', salience: 0.75, tags: ['season', 'reviewed', ...candidate.tags] }, candidate.sourceRefs[0]!, `review:${candidate.id}`)
            if (written) memories++
        }
        const day = this.workspace.situation.current().facts.day
        for (const item of decision.flags ?? []) {
            const candidate = state.flagCandidates.find(flag => flag.id === item.id && episode.review!.flags.includes(flag.id))
            if (!candidate || candidate.status !== 'pending') { rejected.push(`${item.id}: unknown or settled candidate`); continue }
            if (item.decision !== 'accept') { candidate.status = 'rejected'; continue }
            const dueDay = item.dueDay ?? candidate.dueDay
            if (candidate.kind === 'needs_clarification') { rejected.push(`${item.id}: game data cannot judge this flag`); continue }
            if (!Number.isSafeInteger(dueDay) || dueDay! < 1 || typeof day === 'number' && dueDay! < day) {
                rejected.push(`${item.id}: needs a game-day deadline not earlier than the current day`); continue
            }
            const value = candidate.kind === 'money_gte' ? item.value ?? candidate.value : item.value ?? candidate.value
            if (candidate.kind === 'money_gte' && typeof value !== 'number') { rejected.push(`${item.id}: needs a numeric target`); continue }
            const situation = this.workspace.situation.current()
            const flag: Commitment = { id: this.nextId('game_flag'), text: candidate.text, madeAtSim: candidate.atSim, dueAtSim: Number.MAX_SAFE_INTEGER,
                status: 'open', owner: 'user', counterpart: 'jingjing', sourceRef: candidate.sourceRef,
                criterion: { kind: candidate.kind, worldId: this.worldId, runId: state.runId ?? String(situation.facts.runId ?? ''),
                    ...(typeof value === 'number' ? { value } : {}), ...(candidate.target ? { target: candidate.target } : {}),
                    ...(candidate.kind === 'avoid_purchase' ? { readerSession: String(situation.facts.readerSession ?? ''),
                        readerSeq: Number(situation.facts.readerSeq ?? -1), coverageIntact: typeof situation.facts.readerSeq === 'number' } : {}) } }
            this.workspace.motivation.add(flag)
            state.flagDeadlines[flag.id] = dueDay!
            candidate.status = 'accepted'
            this.remember({ kind: 'episodic', title: '主播立了一个 flag', content: `用户说：${candidate.text}；判定规则：${candidate.kind}，截止第 ${dueDay} 天`,
                status: 'fact', origin: 'user_message', salience: 0.8, tags: ['commitment', 'user_flag'] }, candidate.sourceRef, `flag_open:${flag.id}`)
            flags++
        }
        episode.reviewApplied = true
        this.save(state)
        this.workspace.audit.append('decision', 'runtime', `应用 ${decision.reviewId} 审核结果`, { memories, flags, rejected })
        return { memories, flags, rejected }
    }

    /* ------------------------------------------------------------ context */

    /** World-context section: season premise, current stance and the opening ledger. */
    worldContext(): string {
        const state = this.state()
        const lines = [`【本季剧本｜${this.script.title}｜立场提示，不是台词，不是已发生事件的来源】`, this.script.premise]
        const current = this.script.beats.find(beat => beat.id === state.current)
        if (!current) lines.push('当前节拍：尚未开局。只按读取器确认的事件推进，主播口头说法不推进剧情。')
        else lines.push(`当前节拍：${current.actTitle}·${current.title}。立场：${current.stance}`)
        const transient = this.script.beats.find(beat => beat.id === state.transient)
        if (transient) lines.push(`刚刚发生：${transient.title}。本轮立场：${transient.stance}`)
        if (state.entered.B3) lines.push('口头禅可用：利润这么好看，八成是偷来的。化学生意只谈买卖、利润和风险，不谈任何制作信息。')
        if (state.ended) lines.push(`本季已结束：${state.ended.kind === 'success' ? '终幕' : '失败分支'}；不再推进新节拍。`)
        const episode = this.episode(state)
        if (episode && !episode.openingDelivered) lines.push(episode.opening)
        return redactRecipeTerms(lines.join('\n'))
    }
}
