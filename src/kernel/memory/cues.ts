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
 *
 * Derived keys: a CJK key of 3+ characters also matches without its last character (火锅店 → 火锅),
 * at half weight. M0 memory probes 2026-11-19: the model wrote 火锅店 while the user said 吃火锅,
 * in 2 of 5 sessions. Dropping the first character instead rescued nothing and only added noise.
 */

import type { MemoryEntry } from '../types.ts'
import { STOPWORDS } from '../util/text.ts'

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
    /** Keys found in the text, longest first; derived keys appear as matched */
    keys: string[]
}

const CJK_KEY = /^[一-鿿]+$/
const DERIVED_WEIGHT = 0.5

/** 火锅店 → 火锅; null for short or non-CJK keys, and when the result starts with a function word (那部电影). */
export function derivedKey(key: string): string | null {
    if (key.length < 3 || !CJK_KEY.test(key)) return null
    const derived = key.slice(0, -1)
    return STOPWORDS.has(derived[0]!) ? null : derived
}

/** Unique keys, longest first, without keys contained in a longer one. */
function outermost(keys: readonly string[]): string[] {
    const sorted = [...new Set(keys)].sort((a, b) => b.length - a.length || a.localeCompare(b))
    return sorted.filter((k, i) => !sorted.slice(0, i).some((longer) => longer.includes(k)))
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
        const own = cueKeys(entry)
        const full = own.filter((k) => text.includes(k))
        const derived = own
            .filter((k) => !text.includes(k))
            .map(derivedKey)
            .filter((k): k is string => k !== null && text.includes(k))
        if (full.length === 0 && derived.length === 0) continue
        // Longer and more keys = more specific; a key inside a longer matched key adds nothing.
        const fullKeys = outermost(full)
        const derivedKeys = outermost(derived).filter((k) => !fullKeys.some((f) => f.includes(k)))
        const weight = fullKeys.reduce((sum, k) => sum + k.length, 0) +
            derivedKeys.reduce((sum, k) => sum + k.length * DERIVED_WEIGHT, 0)
        const keys = [...new Set([...full, ...derived])].sort((a, b) => b.length - a.length || a.localeCompare(b))
        hits.push({ entry, keys, weight })
    }
    hits.sort((a, b) =>
        b.weight - a.weight ||
        b.entry.salience - a.entry.salience ||
        b.entry.createdAtSim - a.entry.createdAtSim ||
        a.entry.id.localeCompare(b.entry.id))
    return hits.slice(0, opts.limit).map(({ entry, keys }) => ({ entry, keys }))
}
