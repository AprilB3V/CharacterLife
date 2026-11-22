/**
 * Social cognition · types (theory of mind, T0).
 *
 * A pluggable module: the character's guesses about other people's intent and feelings.
 * Every guess is a hypothesis, never a fact: it decays, can be refuted, and sensitive guesses
 * never reach storage. See docs/THEORY_OF_MIND.md.
 *
 * Semantics: short-term interaction state belongs to Situation (beliefs that go stale), the
 * long-term model of a person and their cue rules belong to Memory. The module does not add a
 * kernel slot and does not touch the policy whitelist; it owns one plain-JSON state (one
 * extension-state key), so turning it off or rolling it back leaves the kernel unchanged.
 */

import type { Semantic } from '../semantics/index.ts'

export const SOCIAL_STATE_VERSION = 1
/** Extension-state key for a workspace; deleting it is the rollback */
export const SOCIAL_STATE_KEY = 'social.v1'

export const HYPOTHESIS_KINDS = ['intent', 'emotion', 'focus', 'expectation', 'preference', 'relation'] as const
export type HypothesisKind = (typeof HYPOTHESIS_KINDS)[number]

/** Live only within an interaction; cleared on session end or a long gap */
export const SHORT_TERM_KINDS: readonly HypothesisKind[] = ['intent', 'emotion', 'focus', 'expectation']
/** Kept across sessions (unless sensitive) */
export const LONG_TERM_KINDS: readonly HypothesisKind[] = ['preference', 'relation']

export type HypothesisStatus = 'open' | 'confirmed' | 'refuted' | 'expired'
export type Sensitivity = 'normal' | 'sensitive'

/** How the evidence was observed: said outright > shown by behaviour > read from tone */
export type EvidenceStrength = 'stated' | 'behavior' | 'tone'

/** One piece of evidence from the extractor (LLM first, active cue rules as fallback). */
export interface SocialEvidence {
    about: string
    kind: HypothesisKind
    claim: string
    direction: 'support' | 'against'
    strength: EvidenceStrength
    /** Observation / memory ref */
    ref: string
    /** Target an existing hypothesis; otherwise matched by normalized claim */
    hypothesisId?: string
    /** Cue rule that fired for this evidence */
    cueRuleId?: string
    /** Extractor's own sensitivity flag; unioned with the lexicon */
    sensitive?: boolean
    /** For expectation: what they will do next, checked against the next observation */
    prediction?: string
}

export interface Hypothesis {
    id: string
    about: string
    kind: HypothesisKind
    claim: string
    confidence: number
    support: string[]
    against: string[]
    status: HypothesisStatus
    sensitivity: Sensitivity
    /** Sensitive categories hit (empty when normal) */
    categories: string[]
    /** Session ids whose evidence supported it (promotion needs several) */
    sessions: string[]
    /** Cue rules that contributed; credited or blamed when the guess is confirmed or denied */
    cueRuleIds: string[]
    prediction: string | null
    /** Cue rules behind the current prediction only; scored once when it resolves */
    predictionCueRuleIds: string[]
    createdAtSim: number
    lastEvidenceSim: number
    closedAtSim: number | null
}

export type CueRuleStatus = 'proposed' | 'active' | 'retired'

/** A per-person cue proposed by the character: "when they say X, it usually means Y". */
export interface CueRule {
    id: string
    about: string
    cue: string
    implies: { kind: HypothesisKind; claim: string }
    /** 0..1 reliability from prediction outcomes; only counts once active */
    weight: number
    hits: number
    misses: number
    status: CueRuleStatus
    proposedAtSim: number
    sourceRefs: string[]
}

export interface PersonModel {
    about: string
    hypotheses: Hypothesis[]
    cues: CueRule[]
    lastSeenSim: number | null
    /** Host session id, as given to beginSession */
    sessionId: string | null
    /** Internal key of the current interaction; a new one after every gap (promotion counts these) */
    sessionKey: string | null
}

/** What is persisted. Sensitive hypotheses are never in here. */
export interface SocialState {
    version: number
    seq: number
    people: Record<string, PersonModel>
}

export interface SocialStore {
    load(): SocialState | null
    save(state: SocialState): void
}

export interface SocialConfig {
    /** Base update weight per evidence strength */
    strengthWeight: Record<EvidenceStrength, number>
    /** Upper bound of a single update */
    maxWeight: number
    /** Half-life per kind (ms) */
    halfLifeMs: Record<HypothesisKind, number>
    /** Below this a hypothesis is refuted (by evidence) or expired (by decay) */
    dropBelow: number
    /** A gap longer than this starts a new session and clears short-term state */
    sessionGapMs: number
    maxShortTermOpen: number
    maxLongTermOpen: number
    maxCues: number
    /** Closed hypotheses kept per person for the audit trail */
    closedKept: number
    /** Cue rule state machine */
    cueActivateHits: number
    cueActivateRate: number
    cueRetireTrials: number
    cueRetireRate: number
    /** Distinct supporting sessions before a long-term guess may be mirrored into memory */
    promoteSessions: number
}

export type SocialChangeKind =
    | 'opened' | 'updated' | 'confirmed' | 'refuted' | 'expired' | 'cleared'
    | 'cue_proposed' | 'cue_rejected' | 'cue_activated' | 'cue_retired' | 'cue_scored'

/** Audit record. `detail` never carries a sensitive claim, only its hash. */
export interface SocialChange {
    kind: SocialChangeKind
    about: string
    id: string
    semantic: Extract<Semantic, 'situation' | 'memory'>
    sensitive: boolean
    detail: string
}

export type ConfidenceBand = 'likely' | 'maybe' | 'unsure'

export interface HypothesisLine {
    id: string
    kind: HypothesisKind
    claim: string
    band: ConfidenceBand
    confidence: number
    status: HypothesisStatus
    /** Renderer must only use it to adjust tone, never say it back */
    sensitive: boolean
    prediction: string | null
}

export interface CueLine {
    id: string
    cue: string
    implies: string
    status: CueRuleStatus
    hitRate: number | null
}

export interface SocialView {
    about: string
    /** Short-term: intent / emotion / focus / expectation */
    now: HypothesisLine[]
    /** Long-term: preference / relation (confirmed first) */
    model: HypothesisLine[]
    /** Active cues, then a few proposed ones as reference */
    cues: CueLine[]
}
