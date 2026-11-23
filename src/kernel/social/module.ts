/**
 * Social cognition module: observe -> update hypotheses -> (host picks an action) -> feedback -> revise.
 *
 * Pluggable by construction:
 *   - `createSocialCognition({ enabled: false })` returns a no-op port with the same surface,
 *     so the T3 ablation arm differs from the treatment arm by one flag;
 *   - all persistent state is one plain-JSON object behind `SocialStore` (one extension-state key).
 *     Rollback = delete that key while no instance runs, or call `reset()` on the running one
 *     (a live instance would otherwise write its state back on the next change);
 *     an unknown version or malformed record loads as empty instead of failing;
 *   - it never writes kernel state. Mirroring promotable guesses into memory is the host's call.
 *
 * Sensitive hypotheses live in a separate in-memory pool: never in `snapshot()`, never saved,
 * dropped at session end, and audit records carry only their hash. The lexicon runs on the full
 * text before truncation and again on load. Sensitivity flagged later can redact this call's
 * records and purge stored traces, but cannot recall audit records already handed out.
 */

import type {
    CueRule, Hypothesis, HypothesisKind, HypothesisLine, PersonModel, SocialChange, SocialChangeKind,
    SocialConfig, SocialEvidence, SocialState, SocialStore, SocialView, CueLine,
} from './types.ts'
import { HYPOTHESIS_KINDS, SOCIAL_STATE_VERSION } from './types.ts'
import {
    DEFAULT_SOCIAL_CONFIG, againstUpdate, band, cueReliability, effectiveConfidence, evidenceWeight,
    findMatch, isLongTerm, isShortTerm, normalizeClaim, promotable, supportUpdate,
} from './hypotheses.ts'
import { redact, sensitiveCategories } from './sensitivity.ts'
import { sanitizeForMemory } from '../util/text.ts'

const CLAIM_MAX = 80
const CUE_MAX = 40
const REFS_KEPT = 10
/** Raw input inspected by the lexicon (before truncation) */
const RAW_MAX = 2000

export interface CueProposal {
    about: string
    cue: string
    implies: { kind: HypothesisKind; claim: string }
    sourceRef: string
}

export interface ViewLimits {
    now?: number
    model?: number
    cues?: number
    proposedCues?: number
}

export interface SocialCognitionPort {
    readonly enabled: boolean
    /** Start (or continue) an interaction; a long gap or a new session id clears short-term state */
    beginSession(about: string, sessionId: string, nowSim: number): SocialChange[]
    /** Clear short-term state and every sensitive guess about this person */
    endSession(about: string, nowSim: number): SocialChange[]
    observe(evidence: readonly SocialEvidence[], nowSim: number): SocialChange[]
    /** Check an expectation's prediction against what actually happened */
    resolvePrediction(hypothesisId: string, hit: boolean, ref: string, nowSim: number): SocialChange[]
    proposeCue(proposal: CueProposal, nowSim: number): SocialChange[]
    /** Expire decayed guesses and trim closed ones */
    sweep(nowSim: number): SocialChange[]
    view(about: string, nowSim: number, limits?: ViewLimits): SocialView
    /** Long-term guesses eligible to be mirrored into memory as speculation */
    promotable(about: string, nowSim: number): Hypothesis[]
    /** Drop everything about a person (their request, or a per-person rollback) */
    forget(about: string): SocialChange[]
    /** Drop everything and save the empty state (rollback while running) */
    reset(): void
    people(): string[]
    /** Persistable state; contains no sensitive hypothesis */
    snapshot(): SocialState
}

export interface SocialCognitionOptions {
    enabled: boolean
    store?: SocialStore
    config?: Partial<SocialConfig>
}

export function emptySocialState(): SocialState {
    return { version: SOCIAL_STATE_VERSION, seq: 0, people: {} }
}

const KIND_SET = new Set<string>(HYPOTHESIS_KINDS)
const STATUS_SET = new Set<string>(['open', 'confirmed', 'refuted', 'expired'])
const CUE_STATUS_SET = new Set<string>(['proposed', 'active', 'retired'])
const FORBIDDEN_IDS = new Set(['__proto__', 'constructor', 'prototype'])
const PERSON_ID_MAX = 128

/** A person id usable as an own key of the state object. */
export function isPersonId(x: unknown): x is string {
    return typeof x === 'string' && x.length > 0 && x.length <= PERSON_ID_MAX && x !== '*' && !FORBIDDEN_IDS.has(x)
}

function isKind(x: unknown): x is HypothesisKind {
    return typeof x === 'string' && KIND_SET.has(x)
}

function isStringArray(x: unknown): x is string[] {
    return Array.isArray(x) && x.every((v) => typeof v === 'string')
}

function isFiniteNumber(x: unknown): x is number {
    return typeof x === 'number' && Number.isFinite(x)
}

function isRecord(x: unknown): x is Record<string, unknown> {
    return typeof x === 'object' && x !== null && !Array.isArray(x)
}

function idNumber(id: string): number {
    const m = /^soc_[hcs](\d+)$/.exec(id)
    return m ? Number(m[1]) : 0
}

function validHypothesis(h: unknown, about: string): h is Hypothesis {
    if (!isRecord(h)) return false
    return typeof h.id === 'string' && h.about === about && isKind(h.kind)
        && typeof h.status === 'string' && STATUS_SET.has(h.status)
        // Only long-term kinds may be confirmed
        && (h.status !== 'confirmed' || isLongTerm(h.kind))
        && typeof h.claim === 'string' && isFiniteNumber(h.confidence) && h.sensitivity === 'normal'
        && isStringArray(h.support) && isStringArray(h.against) && isStringArray(h.sessions)
        && isStringArray(h.cueRuleIds) && isStringArray(h.categories)
        && (h.prediction === null || typeof h.prediction === 'string')
        && (h.predictionCueRuleIds === undefined || isStringArray(h.predictionCueRuleIds))
        && isFiniteNumber(h.createdAtSim) && isFiniteNumber(h.lastEvidenceSim)
        && (h.closedAtSim === null || isFiniteNumber(h.closedAtSim))
        // Re-check the lexicon: sensitive text never comes back from disk
        && sensitiveCategories(h.claim, h.prediction as string | null).length === 0
}

function validCue(c: unknown, about: string): c is CueRule {
    if (!isRecord(c) || !isRecord(c.implies)) return false
    return typeof c.id === 'string' && c.about === about && typeof c.cue === 'string'
        && isKind(c.implies.kind) && typeof c.implies.claim === 'string'
        && typeof c.status === 'string' && CUE_STATUS_SET.has(c.status)
        && isFiniteNumber(c.weight) && isFiniteNumber(c.hits) && isFiniteNumber(c.misses)
        && isFiniteNumber(c.proposedAtSim) && isStringArray(c.sourceRefs)
        && sensitiveCategories(c.cue, c.implies.claim).length === 0
}

/** Validate loaded state; anything malformed, sensitive or from another version is dropped. */
export function loadSocialState(raw: unknown): SocialState {
    try {
        if (!isRecord(raw) || raw.version !== SOCIAL_STATE_VERSION || !isRecord(raw.people)) return emptySocialState()
        let seq = isFiniteNumber(raw.seq) ? raw.seq : 0
        const people: Record<string, PersonModel> = {}
        for (const [about, p] of Object.entries(raw.people)) {
            // The outer key is authoritative: a record whose `about` disagrees is dropped, never re-homed.
            if (!isPersonId(about) || !isRecord(p) || !Array.isArray(p.hypotheses) || !Array.isArray(p.cues)) continue
            const hypotheses = structuredClone(p.hypotheses.filter((h) => validHypothesis(h, about)))
            for (const h of hypotheses) h.predictionCueRuleIds ??= []
            const cues = structuredClone(p.cues.filter((c) => validCue(c, about)))
            const sessionKey = typeof p.sessionKey === 'string' ? p.sessionKey : null
            for (const id of [...hypotheses.map((h) => h.id), ...cues.map((c) => c.id), sessionKey ?? '']) {
                seq = Math.max(seq, idNumber(id))
            }
            people[about] = {
                about,
                hypotheses,
                cues,
                lastSeenSim: isFiniteNumber(p.lastSeenSim) ? p.lastSeenSim : null,
                sessionId: typeof p.sessionId === 'string' ? p.sessionId : null,
                sessionKey,
            }
        }
        return { version: SOCIAL_STATE_VERSION, seq, people }
    } catch {
        return emptySocialState()
    }
}

function rawText(text: unknown): string {
    return typeof text === 'string' ? text.slice(0, RAW_MAX) : ''
}

function cleanText(text: string, max: number): string {
    return sanitizeForMemory(text, max * 2).replace(/\s+/g, ' ').trim().slice(0, max)
}

function pushUnique(list: string[], value: string, keep: number): void {
    if (!value || list.includes(value)) return
    list.push(value)
    if (list.length > keep) list.splice(0, list.length - keep)
}

function mergeConfig(partial: Partial<SocialConfig> | undefined): SocialConfig {
    const base = structuredClone(DEFAULT_SOCIAL_CONFIG)
    const extra = structuredClone(partial ?? {})
    return {
        ...base,
        ...extra,
        strengthWeight: { ...base.strengthWeight, ...extra.strengthWeight },
        halfLifeMs: { ...base.halfLifeMs, ...extra.halfLifeMs },
    }
}

/** Disabled port: same surface, no state, no effect. */
export class DisabledSocialCognition implements SocialCognitionPort {
    readonly enabled = false
    beginSession(): SocialChange[] { return [] }
    endSession(): SocialChange[] { return [] }
    observe(): SocialChange[] { return [] }
    resolvePrediction(): SocialChange[] { return [] }
    proposeCue(): SocialChange[] { return [] }
    sweep(): SocialChange[] { return [] }
    view(about: string): SocialView { return { about, now: [], model: [], cues: [] } }
    promotable(): Hypothesis[] { return [] }
    forget(): SocialChange[] { return [] }
    reset(): void {}
    people(): string[] { return [] }
    snapshot(): SocialState { return emptySocialState() }
}

interface ApplyOptions {
    /** false when the caller scores cues itself (prediction feedback) */
    scoreCues: boolean
    /** false: only update an existing live hypothesis, never open one */
    create: boolean
}

export class SocialCognition implements SocialCognitionPort {
    readonly enabled = true
    readonly config: SocialConfig
    #state: SocialState
    #sensitive = new Map<string, Hypothesis[]>()
    #store: SocialStore | null

    constructor(options: { store?: SocialStore; config?: Partial<SocialConfig> } = {}) {
        this.config = mergeConfig(options.config)
        this.#store = options.store ?? null
        this.#state = loadSocialState(this.#store?.load() ?? null)
    }

    /* ---------------- sessions ---------------- */

    beginSession(about: string, sessionId: string, nowSim: number): SocialChange[] {
        if (!isPersonId(about)) return []
        const person = this.#person(about)
        const changes: SocialChange[] = []
        if (this.#gapped(person, nowSim) || (person.sessionId !== null && person.sessionId !== sessionId)) {
            changes.push(...this.#endInteraction(person, nowSim))
        }
        person.sessionId = sessionId
        person.sessionKey ??= `soc_s${++this.#state.seq}`
        person.lastSeenSim = nowSim
        this.#save()
        return changes
    }

    endSession(about: string, nowSim: number): SocialChange[] {
        const person = this.#get(about)
        if (!person) return this.#dropSensitive(about)
        const changes = this.#endInteraction(person, nowSim)
        this.#save()
        return changes
    }

    /* ---------------- evidence ---------------- */

    observe(evidence: readonly SocialEvidence[], nowSim: number): SocialChange[] {
        const changes: SocialChange[] = []
        for (const e of evidence) changes.push(...this.#apply(e, nowSim, { scoreCues: true, create: true }))
        this.#save()
        return this.#redactLate(changes)
    }

    #apply(e: SocialEvidence, nowSim: number, opts: ApplyOptions): SocialChange[] {
        if (!isRecord(e) || !isPersonId(e.about) || !isKind(e.kind)) return []
        if (e.direction !== 'support' && e.direction !== 'against') return []
        if (!Object.hasOwn(this.config.strengthWeight, e.strength)) return []
        const rawClaim = rawText(e.claim)
        const rawPrediction = e.kind === 'expectation' ? rawText(e.prediction) : ''
        const claim = cleanText(rawClaim, CLAIM_MAX)
        if (!claim || normalizeClaim(claim) === '') return []
        const prediction = rawPrediction ? cleanText(rawPrediction, CLAIM_MAX) || null : null
        const ref = typeof e.ref === 'string' ? e.ref : ''

        const person = this.#person(e.about)
        const changes = this.#touch(person, nowSim)

        // Lexicon on the full input, before truncation can cut a sensitive word off
        const categories = sensitiveCategories(rawClaim, rawPrediction)
        if (e.sensitive === true && categories.length === 0) categories.push('flagged')
        const sensitive = categories.length > 0
        const pool = this.#sensitivePool(e.about)

        let target: Hypothesis | null = this.#byId(person, e.hypothesisId)
        if (target && ((target.status !== 'open' && target.status !== 'confirmed') || target.kind !== e.kind)) target = null
        target ??= findMatch(person.hypotheses, e.kind, claim) ?? findMatch(pool, e.kind, claim)
        const cue = typeof e.cueRuleId === 'string' ? person.cues.find((c) => c.id === e.cueRuleId) ?? null : null

        if (sensitive) {
            // Stored traces of this claim go: closed records with the same claim, and the cue behind it.
            const key = normalizeClaim(claim)
            person.hypotheses = person.hypotheses.filter((h) => h === target || h.kind !== e.kind || normalizeClaim(h.claim) !== key)
            if (cue) person.cues = person.cues.filter((c) => c !== cue)
            if (target && target.sensitivity === 'normal') {
                person.hypotheses = person.hypotheses.filter((h) => h !== target)
                target.sensitivity = 'sensitive'
                target.categories = categories
                pool.push(target)
            }
        }
        const liveCue = sensitive ? null : cue
        const w = evidenceWeight(e.strength, liveCue, this.config)
        const confirmable = isLongTerm(e.kind) && e.strength === 'stated'

        if (!target) {
            if (e.direction !== 'support' || !opts.create) return changes
            const isSensitive = sensitive
            const h: Hypothesis = {
                id: `soc_h${++this.#state.seq}`,
                about: e.about,
                kind: e.kind,
                claim,
                confidence: w,
                support: ref ? [ref] : [],
                against: [],
                status: confirmable && !isSensitive ? 'confirmed' : 'open',
                sensitivity: isSensitive ? 'sensitive' : 'normal',
                categories: isSensitive ? categories : [],
                sessions: person.sessionKey ? [person.sessionKey] : [],
                cueRuleIds: liveCue ? [liveCue.id] : [],
                prediction,
                predictionCueRuleIds: prediction && liveCue ? [liveCue.id] : [],
                createdAtSim: nowSim,
                lastEvidenceSim: nowSim,
                closedAtSim: null,
            }
            if (isSensitive) pool.push(h)
            else {
                if (h.status === 'open') {
                    const room = this.#makeRoom(person, e.kind, nowSim)
                    if (room === null) return changes
                    changes.push(...room)
                }
                person.hypotheses.push(h)
            }
            changes.push(this.#change('opened', h, h.status))
            if (h.status === 'confirmed') changes.push(this.#change('confirmed', h, 'stated'))
            return changes
        }

        const refs = e.direction === 'support' ? target.support : target.against
        // The same observation counted twice is not new evidence
        if (ref && refs.includes(ref)) return changes

        const before = effectiveConfidence(target, nowSim, this.config)
        if (liveCue) pushUnique(target.cueRuleIds, liveCue.id, REFS_KEPT)
        if (prediction) {
            target.prediction = prediction
            target.predictionCueRuleIds = liveCue ? [liveCue.id] : []
        }
        target.lastEvidenceSim = nowSim

        if (e.direction === 'support') {
            pushUnique(target.support, ref, REFS_KEPT)
            if (person.sessionKey) pushUnique(target.sessions, person.sessionKey, REFS_KEPT)
            if (target.status === 'confirmed') return changes
            target.confidence = supportUpdate(before, w)
            if (confirmable && target.sensitivity === 'normal') {
                target.status = 'confirmed'
                changes.push(this.#change('confirmed', target, 'stated'))
                if (opts.scoreCues) changes.push(...this.#scoreCues(person, target.cueRuleIds, true))
            } else {
                changes.push(this.#change('updated', target, `+${target.confidence.toFixed(2)}`))
            }
            return changes
        }

        pushUnique(target.against, ref, REFS_KEPT)
        // A confirmed fact only falls to a stated denial; inference alone just leaves a mark.
        if (target.status === 'confirmed' && e.strength !== 'stated') return changes
        target.confidence = e.strength === 'stated' ? 0 : againstUpdate(before, w)
        if (target.confidence < this.config.dropBelow) {
            changes.push(...this.#close(target, 'refuted', nowSim))
            if (opts.scoreCues) changes.push(...this.#scoreCues(person, target.cueRuleIds, false))
        } else {
            changes.push(this.#change('updated', target, `-${target.confidence.toFixed(2)}`))
        }
        return changes
    }

    resolvePrediction(hypothesisId: string, hit: boolean, ref: string, nowSim: number): SocialChange[] {
        for (const person of Object.values(this.#state.people)) {
            const h = this.#byId(person, hypothesisId)
            if (!h) continue
            if (h.kind !== 'expectation' || h.status !== 'open' || h.prediction === null) return []
            // A gap may have ended the interaction: then the guess is gone and nothing is reopened.
            const changes = this.#touch(person, nowSim)
            if (h.status !== 'open' || !this.#isLive(person, h)) {
                this.#save()
                return this.#redactLate(changes)
            }
            const cueIds = [...h.predictionCueRuleIds]
            changes.push(...this.#apply({
                about: h.about, kind: h.kind, claim: h.claim, hypothesisId: h.id,
                direction: hit ? 'support' : 'against', strength: 'behavior', ref,
            }, nowSim, { scoreCues: false, create: false }))
            h.prediction = null
            h.predictionCueRuleIds = []
            changes.push(...this.#scoreCues(person, cueIds, hit))
            this.#save()
            return this.#redactLate(changes)
        }
        return []
    }

    /* ---------------- cue rules ---------------- */

    proposeCue(proposal: CueProposal, nowSim: number): SocialChange[] {
        const about = isRecord(proposal) && typeof proposal.about === 'string' ? proposal.about : ''
        const rawCue = rawText(isRecord(proposal) ? proposal.cue : '')
        const implies: Record<string, unknown> = isRecord(proposal) && isRecord(proposal.implies) ? proposal.implies : {}
        const rawClaim = rawText(implies.claim)
        const kind = implies.kind
        // Audit for a rejection carries a code and a hash, never the proposed text
        const reject = (code: string, sensitive = false): SocialChange[] =>
            [{ kind: 'cue_rejected', about: isPersonId(about) ? about : '', id: '', semantic: 'memory', sensitive, detail: `${code} ${redact(rawCue + rawClaim)}` }]
        if (sensitiveCategories(rawCue, rawClaim).length > 0) return reject('sensitive', true)
        if (!isPersonId(about)) return reject('no_person')
        const cue = cleanText(rawCue, CUE_MAX)
        const claim = cleanText(rawClaim, CLAIM_MAX)
        if (!cue || !claim || !isKind(kind)) return reject('malformed')

        const person = this.#person(about)
        const dup = person.cues.find((c) => c.status !== 'retired' && normalizeClaim(c.cue) === normalizeClaim(cue)
            && c.implies.kind === kind && normalizeClaim(c.implies.claim) === normalizeClaim(claim))
        const sourceRef = typeof proposal.sourceRef === 'string' ? proposal.sourceRef : ''
        if (dup) {
            pushUnique(dup.sourceRefs, sourceRef, REFS_KEPT)
            this.#save()
            return []
        }
        if (person.cues.length >= this.config.maxCues) {
            const retired = person.cues.findIndex((c) => c.status === 'retired')
            if (retired < 0) return reject('full')
            person.cues.splice(retired, 1)
        }
        const rule: CueRule = {
            id: `soc_c${++this.#state.seq}`,
            about,
            cue,
            implies: { kind, claim },
            weight: 0.5,
            hits: 0,
            misses: 0,
            status: 'proposed',
            proposedAtSim: nowSim,
            sourceRefs: sourceRef ? [sourceRef] : [],
        }
        person.cues.push(rule)
        this.#save()
        return [{ kind: 'cue_proposed', about, id: rule.id, semantic: 'memory', sensitive: false, detail: `${cue} => ${kind}:${claim}` }]
    }

    #scoreCues(person: PersonModel, ids: readonly string[], hit: boolean): SocialChange[] {
        const changes: SocialChange[] = []
        const cfg = this.config
        for (const id of new Set(ids)) {
            const rule = person.cues.find((c) => c.id === id)
            if (!rule || rule.status === 'retired') continue
            if (hit) rule.hits++
            else rule.misses++
            rule.weight = cueReliability(rule)
            const trials = rule.hits + rule.misses
            const rate = rule.hits / trials
            const base = { about: person.about, id: rule.id, semantic: 'memory' as const, sensitive: false }
            changes.push({ ...base, kind: 'cue_scored', detail: `${rule.hits}/${trials}` })
            if (trials >= cfg.cueRetireTrials && rate < cfg.cueRetireRate) {
                rule.status = 'retired'
                changes.push({ ...base, kind: 'cue_retired', detail: `${rule.hits}/${trials}` })
            } else if (rule.status === 'proposed' && rule.hits >= cfg.cueActivateHits && rate >= cfg.cueActivateRate) {
                rule.status = 'active'
                changes.push({ ...base, kind: 'cue_activated', detail: `${rule.hits}/${trials}` })
            }
        }
        return changes
    }

    /* ---------------- maintenance ---------------- */

    sweep(nowSim: number): SocialChange[] {
        const changes: SocialChange[] = []
        for (const person of Object.values(this.#state.people)) {
            changes.push(...this.#touch(person, nowSim, false))
            for (const h of [...person.hypotheses, ...(this.#sensitive.get(person.about) ?? [])]) {
                if (h.status === 'open' && effectiveConfidence(h, nowSim, this.config) < this.config.dropBelow) {
                    changes.push(...this.#close(h, 'expired', nowSim))
                }
            }
            this.#trimClosed(person)
        }
        this.#save()
        return changes
    }

    forget(about: string): SocialChange[] {
        const changes = this.#dropSensitive(about)
        if (this.#get(about)) {
            delete this.#state.people[about]
            changes.push({ kind: 'cleared', about, id: '', semantic: 'memory', sensitive: false, detail: 'forget' })
            this.#save()
        }
        return changes
    }

    reset(): void {
        this.#state = emptySocialState()
        this.#sensitive.clear()
        this.#save()
    }

    /* ---------------- reading (no side effects) ---------------- */

    view(about: string, nowSim: number, limits: ViewLimits = {}): SocialView {
        const person = this.#get(about)
        const out: SocialView = { about, now: [], model: [], cues: [] }
        if (!person) return out
        // After a gap the interaction is over even if nobody has called sweep yet
        const ended = this.#gapped(person, nowSim)
        const line = (h: Hypothesis): HypothesisLine => {
            const c = effectiveConfidence(h, nowSim, this.config)
            return {
                id: h.id, kind: h.kind, claim: h.claim, band: band(c), confidence: Number(c.toFixed(3)),
                status: h.status, sensitive: h.sensitivity === 'sensitive', prediction: h.prediction,
            }
        }
        const sensitive = ended ? [] : this.#sensitive.get(about) ?? []
        const live = [...person.hypotheses, ...sensitive]
            .filter((h) => (h.status === 'open' || h.status === 'confirmed')
                && !(ended && isShortTerm(h.kind))
                && effectiveConfidence(h, nowSim, this.config) >= this.config.dropBelow)
            .map(line)
            .sort((a, b) => (a.status === 'confirmed' ? 0 : 1) - (b.status === 'confirmed' ? 0 : 1) || b.confidence - a.confidence)
        const isNow = (l: HypothesisLine): boolean => isShortTerm(l.kind) || l.sensitive
        out.now = live.filter(isNow).slice(0, Math.max(0, limits.now ?? 5))
        out.model = live.filter((l) => !isNow(l)).slice(0, Math.max(0, limits.model ?? 8))
        const cueLine = (c: CueRule): CueLine => ({
            id: c.id, cue: c.cue, implies: `${c.implies.kind}:${c.implies.claim}`, status: c.status,
            hitRate: c.hits + c.misses > 0 ? Number((c.hits / (c.hits + c.misses)).toFixed(2)) : null,
        })
        const active = person.cues.filter((c) => c.status === 'active').sort((a, b) => b.weight - a.weight)
        const proposedLimit = Math.max(0, limits.proposedCues ?? 2)
        const proposed = proposedLimit === 0 ? [] : person.cues.filter((c) => c.status === 'proposed').slice(-proposedLimit)
        out.cues = [...active.slice(0, Math.max(0, limits.cues ?? 6)), ...proposed].map(cueLine)
        return out
    }

    promotable(about: string, nowSim: number): Hypothesis[] {
        const person = this.#get(about)
        if (!person) return []
        return person.hypotheses
            .filter((h) => promotable(h, this.config) && effectiveConfidence(h, nowSim, this.config) >= this.config.dropBelow)
            .map((h) => structuredClone(h))
    }

    people(): string[] {
        return Object.keys(this.#state.people)
    }

    snapshot(): SocialState {
        return structuredClone(this.#state)
    }

    /* ---------------- internals ---------------- */

    #get(about: string): PersonModel | null {
        return Object.hasOwn(this.#state.people, about) ? this.#state.people[about]! : null
    }

    #person(about: string): PersonModel {
        let p = this.#get(about)
        if (!p) {
            p = { about, hypotheses: [], cues: [], lastSeenSim: null, sessionId: null, sessionKey: null }
            this.#state.people[about] = p
        }
        return p
    }

    #sensitivePool(about: string): Hypothesis[] {
        let pool = this.#sensitive.get(about)
        if (!pool) {
            pool = []
            this.#sensitive.set(about, pool)
        }
        return pool
    }

    #byId(person: PersonModel, id: unknown): Hypothesis | null {
        if (typeof id !== 'string' || !id) return null
        return person.hypotheses.find((h) => h.id === id) ?? this.#sensitive.get(person.about)?.find((h) => h.id === id) ?? null
    }

    #isLive(person: PersonModel, h: Hypothesis): boolean {
        return person.hypotheses.includes(h) || (this.#sensitive.get(person.about)?.includes(h) ?? false)
    }

    #gapped(person: PersonModel, nowSim: number): boolean {
        return person.lastSeenSim !== null && nowSim - person.lastSeenSim > this.config.sessionGapMs
    }

    /** Mark the person seen; a long silence ends the previous interaction first. */
    #touch(person: PersonModel, nowSim: number, seen = true): SocialChange[] {
        const changes = this.#gapped(person, nowSim) ? this.#endInteraction(person, nowSim) : []
        if (seen) {
            person.sessionKey ??= `soc_s${++this.#state.seq}`
            person.lastSeenSim = nowSim
        }
        return changes
    }

    /** Clear short-term and sensitive state; the next interaction gets a new session key. */
    #endInteraction(person: PersonModel, nowSim: number): SocialChange[] {
        const changes: SocialChange[] = []
        for (const h of person.hypotheses) {
            if (h.status === 'open' && isShortTerm(h.kind)) {
                h.status = 'expired'
                h.closedAtSim = nowSim
                h.prediction = null
                h.predictionCueRuleIds = []
                changes.push(this.#change('cleared', h, 'session'))
            }
        }
        changes.push(...this.#dropSensitive(person.about))
        this.#trimClosed(person)
        person.sessionId = null
        person.sessionKey = null
        person.lastSeenSim = null
        return changes
    }

    #dropSensitive(about: string): SocialChange[] {
        const pool = this.#sensitive.get(about) ?? []
        this.#sensitive.delete(about)
        return pool.map((h) => this.#change('cleared', h, 'session'))
    }

    /** Close the weakest open guess of the same term; null when the cap leaves no room at all. */
    #makeRoom(person: PersonModel, kind: HypothesisKind, nowSim: number): SocialChange[] | null {
        const short = isShortTerm(kind)
        const cap = short ? this.config.maxShortTermOpen : this.config.maxLongTermOpen
        if (cap <= 0) return null
        const open = person.hypotheses.filter((h) => h.status === 'open' && isShortTerm(h.kind) === short)
        if (open.length < cap) return []
        open.sort((a, b) => effectiveConfidence(a, nowSim, this.config) - effectiveConfidence(b, nowSim, this.config))
        return open.slice(0, open.length - cap + 1).flatMap((h) => this.#close(h, 'expired', nowSim))
    }

    #close(h: Hypothesis, status: 'refuted' | 'expired', nowSim: number): SocialChange[] {
        h.status = status
        h.closedAtSim = nowSim
        h.prediction = null
        h.predictionCueRuleIds = []
        return [this.#change(status, h, status)]
    }

    #trimClosed(person: PersonModel): void {
        const closed = person.hypotheses.filter((h) => h.status === 'refuted' || h.status === 'expired')
        const excess = closed.length - this.config.closedKept
        if (excess <= 0) return
        const drop = new Set(closed.sort((a, b) => (a.closedAtSim ?? 0) - (b.closedAtSim ?? 0)).slice(0, excess))
        person.hypotheses = person.hypotheses.filter((h) => !drop.has(h))
    }

    #change(kind: SocialChangeKind, h: Hypothesis, note: string): SocialChange {
        const sensitive = h.sensitivity === 'sensitive'
        return {
            kind,
            about: h.about,
            id: h.id,
            semantic: isShortTerm(h.kind) ? 'situation' : 'memory',
            sensitive,
            detail: sensitive ? `${h.kind} ${redact(h.claim)} ${note}` : `${h.kind}:${h.claim} ${note}`,
        }
    }

    /** Records made earlier in this call about a guess that has since turned sensitive get redacted. */
    #redactLate(changes: SocialChange[]): SocialChange[] {
        const sensitiveIds = new Set<string>()
        for (const pool of this.#sensitive.values()) for (const h of pool) sensitiveIds.add(h.id)
        return changes.map((c) => {
            if (c.sensitive || !sensitiveIds.has(c.id)) return c
            const h = this.#sensitive.get(c.about)?.find((x) => x.id === c.id)
            return { ...c, sensitive: true, detail: h ? `${h.kind} ${redact(h.claim)} ${c.kind}` : redact(c.detail) }
        })
    }

    #save(): void {
        this.#store?.save(this.snapshot())
    }
}

export function createSocialCognition(options: SocialCognitionOptions): SocialCognitionPort {
    if (!options.enabled) return new DisabledSocialCognition()
    return new SocialCognition({ store: options.store, config: options.config })
}
