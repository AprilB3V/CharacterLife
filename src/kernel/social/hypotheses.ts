/**
 * Pure hypothesis arithmetic: confidence updates, decay, merging, promotion.
 *
 * Update rule (bounded, order-dependent like the evidence itself):
 *   support  c <- c + w * (1 - c)
 *   against  c <- c * (1 - w)
 * Decay: effective confidence = c * 0.5 ^ (dt / halfLife), dt from the last evidence.
 * Confirmed hypotheses do not decay; refuted / expired ones are out of play.
 */

import type {
    ConfidenceBand, CueRule, EvidenceStrength, Hypothesis, HypothesisKind, SocialConfig,
} from './types.ts'
import { LONG_TERM_KINDS, SHORT_TERM_KINDS } from './types.ts'
import { HOUR, DAY } from '../util/clock.ts'

const MINUTE = 60 * 1000

export const DEFAULT_SOCIAL_CONFIG: SocialConfig = {
    strengthWeight: { stated: 0.6, behavior: 0.35, tone: 0.2 },
    maxWeight: 0.8,
    halfLifeMs: {
        emotion: 20 * MINUTE,
        intent: HOUR,
        focus: HOUR,
        expectation: HOUR,
        preference: 30 * DAY,
        relation: 60 * DAY,
    },
    dropBelow: 0.15,
    sessionGapMs: 2 * HOUR,
    maxShortTermOpen: 8,
    maxLongTermOpen: 30,
    maxCues: 20,
    closedKept: 20,
    cueActivateHits: 3,
    cueActivateRate: 0.6,
    cueRetireTrials: 6,
    cueRetireRate: 0.4,
    promoteSessions: 3,
}

export function isShortTerm(kind: HypothesisKind): boolean {
    return SHORT_TERM_KINDS.includes(kind)
}

export function isLongTerm(kind: HypothesisKind): boolean {
    return LONG_TERM_KINDS.includes(kind)
}

export function clamp01(x: number): number {
    return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0
}

/** Laplace-smoothed hit rate; 0.5 with no trials. */
export function cueReliability(rule: Pick<CueRule, 'hits' | 'misses'>): number {
    return (rule.hits + 1) / (rule.hits + rule.misses + 2)
}

/**
 * Weight of one piece of evidence. An active cue rule scales it by its reliability
 * (0.5x .. 1.5x); a proposed or retired rule has no effect.
 */
export function evidenceWeight(strength: EvidenceStrength, cue: CueRule | null, cfg: SocialConfig): number {
    let w = cfg.strengthWeight[strength]
    if (cue && cue.status === 'active') w *= 0.5 + cue.weight
    return Math.min(cfg.maxWeight, Math.max(0, w))
}

export function supportUpdate(c: number, w: number): number {
    return clamp01(c + w * (1 - c))
}

export function againstUpdate(c: number, w: number): number {
    return clamp01(c * (1 - w))
}

/** Confidence after decay at `nowSim`. */
export function effectiveConfidence(h: Hypothesis, nowSim: number, cfg: SocialConfig): number {
    if (h.status === 'confirmed') return h.confidence
    if (h.status !== 'open') return 0
    const dt = Math.max(0, nowSim - h.lastEvidenceSim)
    const half = cfg.halfLifeMs[h.kind]
    return clamp01(h.confidence * Math.pow(0.5, dt / half))
}

export function band(confidence: number): ConfidenceBand {
    if (confidence >= 0.7) return 'likely'
    if (confidence >= 0.4) return 'maybe'
    return 'unsure'
}

/** Normalization for claim matching: drop punctuation, particles and case. */
export function normalizeClaim(text: string): string {
    return text
        .toLowerCase()
        .replace(/[\s，。！？、；：,.!?;:"'“”‘’()（）\-—…~]/g, '')
        .replace(/[的了呢吧啊呀哦嗯]/g, '')
}

/** Open or confirmed hypothesis with the same kind and claim. */
export function findMatch(list: readonly Hypothesis[], kind: HypothesisKind, claim: string): Hypothesis | null {
    const key = normalizeClaim(claim)
    if (!key) return null
    return list.find((h) => h.kind === kind && (h.status === 'open' || h.status === 'confirmed') && normalizeClaim(h.claim) === key) ?? null
}

/**
 * A long-term, non-sensitive guess that enough separate sessions supported and nothing
 * contradicted. Eligibility only: mirroring it into memory (as speculation) is the host's call.
 */
export function promotable(h: Hypothesis, cfg: SocialConfig): boolean {
    return h.status === 'open'
        && isLongTerm(h.kind)
        && h.sensitivity === 'normal'
        && h.against.length === 0
        && h.sessions.length >= cfg.promoteSessions
}
