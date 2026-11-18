/**
 * Memory curve: retention decays with time and recall consolidates it.
 *
 * Each memory has a stability S (ms). Retention R = exp(-dt / S), where dt runs from the last time
 * the memory reached a prompt (or from its creation). Recalling a memory raises S, more when it had
 * faded further (spacing effect): S <- S * (1 + growth * (1 - R)). A burst of recalls within one
 * turn barely changes S, so resends cannot inflate it.
 *
 * Tiers: clear (R >= fuzzyBelow), fuzzy (rendered as a vague impression), forgotten
 * (R < forgottenBelow: lexical retrieval skips it; a cue in the user's words can still bring it
 * back). Pinned safety / boundary / address facts never decay.
 *
 * Recall state lives beside the memory, not inside it: memory content stays immutable.
 */

import type { MemoryEntry } from '../types.ts'
import { pinKind } from './pins.ts'
import { cueKeys } from './cues.ts'

const DAY_MS = 24 * 60 * 60 * 1000

export interface RecallState {
    /** Stability S in ms */
    stability: number
    lastRecalledSim: number | null
    recalls: number
}

export interface CurveConfig {
    /** Base stability; a persona's memory strength scales this */
    baseStabilityMs: number
    /** Consolidation strength on recall */
    growth: number
    fuzzyBelow: number
    forgottenBelow: number
    /** Associative consolidation of cue-sharing neighbours; null turns it off */
    association: AssociationOptions | null
}

export const DEFAULT_CURVE: CurveConfig = {
    baseStabilityMs: 5 * DAY_MS,
    growth: 3,
    fuzzyBelow: 0.5,
    forgottenBelow: 0.15,
    // Offline replay of the M0 curve run (2026-11-19): 2+ shared keys, 3 per turn, stability only,
    // kept every session's goal fact reachable while the forgotten share fell from 38/70 to 25/70.
    association: { limit: 3, minShared: 2 },
}

export type RecallTier = 'clear' | 'fuzzy' | 'forgotten'

export function initialRecallState(entry: MemoryEntry, cfg: CurveConfig): RecallState {
    return { stability: cfg.baseStabilityMs * (0.5 + entry.salience), lastRecalledSim: null, recalls: 0 }
}

/** Retention in 0..1; pinned facts always 1. */
export function retention(entry: MemoryEntry, state: RecallState | undefined, nowSim: number, cfg: CurveConfig): number {
    if (pinKind(entry)) return 1
    const s = state ?? initialRecallState(entry, cfg)
    const since = s.lastRecalledSim ?? entry.createdAtSim
    const dt = Math.max(0, nowSim - since)
    return Math.exp(-dt / Math.max(1, s.stability))
}

export function recallTier(r: number, cfg: CurveConfig): RecallTier {
    if (r >= cfg.fuzzyBelow) return 'clear'
    return r >= cfg.forgottenBelow ? 'fuzzy' : 'forgotten'
}

/** The state after a recall at `nowSim`; `r` is the retention just before it. */
export function reinforce(state: RecallState, r: number, nowSim: number, cfg: CurveConfig): RecallState {
    return {
        stability: state.stability * (1 + cfg.growth * (1 - r)),
        lastRecalledSim: nowSim,
        recalls: state.recalls + 1,
    }
}

/**
 * A neighbour of a recalled memory grows sturdier but is not "just recalled": stability grows as on
 * a recall, the clock and the recall count stay. Replay showed resetting the clock left the goal
 * fact fuzzy while keeping more unrelated memories alive.
 */
export function strengthenByAssociation(state: RecallState, r: number, cfg: CurveConfig): RecallState {
    return { ...state, stability: state.stability * (1 + cfg.growth * (1 - r)) }
}

export function isRecallState(value: unknown): value is RecallState {
    if (!value || typeof value !== 'object') return false
    const v = value as Record<string, unknown>
    return typeof v.stability === 'number' && Number.isFinite(v.stability) && v.stability > 0 &&
        (v.lastRecalledSim === null || typeof v.lastRecalledSim === 'number') &&
        typeof v.recalls === 'number'
}

export interface AssociationOptions {
    /** At most this many associated memories per turn */
    limit: number
    /** Minimum shared cue keys */
    minShared: number
}

/**
 * Associative consolidation: memories sharing cue keys with the recalled ones, most shared keys first.
 * M0 curve run 2026-11-19: the half-marathon goal faded although the race came up on day 3 and day 8,
 * because those turns retrieved the new training notes, not the goal itself. A topic coming up
 * should also keep its neighbours alive.
 */
export function associates(
    recalled: readonly MemoryEntry[],
    pool: readonly MemoryEntry[],
    opts: AssociationOptions,
): MemoryEntry[] {
    if (opts.limit <= 0 || recalled.length === 0) return []
    const recalledIds = new Set(recalled.map((e) => e.id))
    const recalledKeys = new Set(recalled.flatMap(cueKeys))
    const scored: Array<{ entry: MemoryEntry; shared: number; chars: number }> = []
    for (const entry of pool) {
        if (recalledIds.has(entry.id) || entry.deletedAtSim !== null || entry.trust === 'untrusted' || pinKind(entry)) continue
        const shared = [...new Set(cueKeys(entry))].filter((k) => recalledKeys.has(k))
        if (shared.length < opts.minShared) continue
        scored.push({ entry, shared: shared.length, chars: shared.reduce((n, k) => n + k.length, 0) })
    }
    scored.sort((a, b) =>
        b.shared - a.shared || b.chars - a.chars || b.entry.salience - a.entry.salience || a.entry.id.localeCompare(b.entry.id))
    return scored.slice(0, opts.limit).map((s) => s.entry)
}
