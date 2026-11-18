/**
 * Pinned memories: a tiny always-present layer for user facts that must never miss a turn.
 *
 * Only three kinds qualify: safety (allergies, illness, medication), boundary (topics the user
 * asked not to touch) and address (how the user wants to be called). They are stored as tags with
 * PIN_TAG_PREFIX, so the schema stays unchanged. Lexical ranking cannot be trusted with them:
 * "recommend a snack" shares no word with "allergic to peanuts".
 */

import type { MemoryEntry } from '../types.ts'

export const PIN_TAG_PREFIX = 'pin:'
export const PIN_KINDS = ['safety', 'boundary', 'address'] as const
export type PinKind = (typeof PIN_KINDS)[number]

/** Lower rank comes first when the layer is full. */
const PIN_RANK: Record<PinKind, number> = { safety: 0, boundary: 1, address: 2 }

export function isPinKind(value: unknown): value is PinKind {
    return typeof value === 'string' && (PIN_KINDS as readonly string[]).includes(value)
}

/** The pin kind of a memory, or null when it is not pinned. */
export function pinKind(entry: MemoryEntry): PinKind | null {
    for (const tag of entry.tags) {
        if (!tag.startsWith(PIN_TAG_PREFIX)) continue
        const kind = tag.slice(PIN_TAG_PREFIX.length)
        if (isPinKind(kind)) return kind
    }
    return null
}

export interface PinnedOptions {
    limit: number
    /** Total title + content characters */
    budgetChars: number
}

/**
 * Selects the pinned layer: trusted, live user memories only; safety before boundary before
 * address, newest first within a kind; only the newest address survives (a later name replaces
 * the earlier one).
 */
export function selectPinned(entries: readonly MemoryEntry[], opts: PinnedOptions): MemoryEntry[] {
    if (opts.limit <= 0) return []
    const candidates: Array<{ entry: MemoryEntry; kind: PinKind }> = []
    for (const entry of entries) {
        if (entry.deletedAtSim !== null || entry.trust === 'untrusted' || entry.kind !== 'user') continue
        const kind = pinKind(entry)
        if (kind) candidates.push({ entry, kind })
    }
    candidates.sort((a, b) =>
        PIN_RANK[a.kind] - PIN_RANK[b.kind] ||
        b.entry.createdAtSim - a.entry.createdAtSim ||
        a.entry.id.localeCompare(b.entry.id))
    const out: MemoryEntry[] = []
    let used = 0
    let addressTaken = false
    for (const { entry, kind } of candidates) {
        if (out.length >= opts.limit) break
        if (kind === 'address') {
            if (addressTaken) continue
            addressTaken = true
        }
        const cost = entry.title.length + entry.content.length
        if (used + cost > opts.budgetChars) continue
        out.push(entry)
        used += cost
    }
    return out
}
