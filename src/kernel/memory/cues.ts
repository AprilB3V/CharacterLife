/**
 * Cue recall: a second retrieval channel beside lexical ranking.
 *
 * Every memory may carry cue keys: model-written `cues`, stored as tags with CUE_TAG_PREFIX so that
 * category tags (日常, 宠物) never act as cues. When a key
 * appears verbatim in the current text, the memory is recalled through this channel regardless of
 * its lexical score. M0 baseline 2026-11-18: "我的猫叫什么来着" ranked the stored cat fact 6th,
 * 0.004 below the top-5 cut, because a single shared character carries little lexical weight.
 *
 * The key dictionary comes from the memories themselves, so no word segmenter is needed.
 */

import type { MemoryEntry } from '../types.ts'

export const CUE_TAG_PREFIX = 'cue:'

/** Cue keys of a memory: its prefixed tags, without the prefix. */
export function cueKeys(entry: MemoryEntry): string[] {
    return entry.tags
        .filter((t) => t.startsWith(CUE_TAG_PREFIX))
        .map((t) => t.slice(CUE_TAG_PREFIX.length).trim())
        .filter((k) => k.length > 0)
}

export interface CueRecall {
    entry: MemoryEntry
    /** Keys found in the text, longest first */
    keys: string[]
}

export interface CueRecallOptions {
    limit: number
    /** Memories already retrieved by the lexical channel */
    excludeIds?: ReadonlySet<string>
}

/** Recalls memories whose cue keys occur in `text`; deterministic order. */
export function recallByCues(entries: readonly MemoryEntry[], text: string, opts: CueRecallOptions): CueRecall[] {
    if (opts.limit <= 0 || text.length === 0) return []
    const hits: Array<CueRecall & { weight: number }> = []
    for (const entry of entries) {
        if (entry.deletedAtSim !== null || entry.trust === 'untrusted') continue
        if (opts.excludeIds?.has(entry.id)) continue
        const keys = [...new Set(cueKeys(entry).filter((k) => text.includes(k)))]
        if (keys.length === 0) continue
        keys.sort((a, b) => b.length - a.length || a.localeCompare(b))
        // Longer and more keys = more specific; a key contained in a longer matched key adds nothing.
        const weight = keys
            .filter((k, i) => !keys.slice(0, i).some((longer) => longer.includes(k)))
            .reduce((sum, k) => sum + k.length, 0)
        hits.push({ entry, keys, weight })
    }
    hits.sort((a, b) =>
        b.weight - a.weight ||
        b.entry.salience - a.entry.salience ||
        b.entry.createdAtSim - a.entry.createdAtSim ||
        a.entry.id.localeCompare(b.entry.id))
    return hits.slice(0, opts.limit).map(({ entry, keys }) => ({ entry, keys }))
}
