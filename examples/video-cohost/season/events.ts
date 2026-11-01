/**
 * Game event vocabulary for Probably Stolen.
 *
 * Only world observations from the reader (`source: probably-stolen`) and events the
 * adapter derives from reader snapshots may carry these tags. User speech and model
 * output never produce them.
 */
import type { SeasonConfig } from './config.ts'

const ID = '[A-Za-z0-9_.-]{1,64}'

export const GAME_EVENT_PATTERNS: readonly RegExp[] = [
    /^day_start:\d{1,5}$/,
    /^rent_due$/, /^rent_paid$/, /^rent_missed$/,
    /^deficit$/, /^deficit_persisted$/, /^deficit_cleared$/,
    new RegExp(`^sale:${ID}$`), /^first_chem_sale$/, /^profit_margin_high$/,
    new RegExp(`^item_bought:${ID}$`),
    /^investigation_(near_threshold|over_threshold|reset)$/,
    new RegExp(`^npc_(arrived|left):${ID}$`),
    /^inspection_(passed|failed)$/, /^fine$/, /^raid$/, /^evidence_removal_used$/,
    /^kill:ai_controlled$/,
    new RegExp(`^story:${ID}$`),
    new RegExp(`^achievement:${ID}$`),
    new RegExp(`^game_over:${ID}$`),
    /^store_bought$/,
]

export function isGameEvent(tag: string): boolean {
    return GAME_EVENT_PATTERNS.some(pattern => pattern.test(tag))
}

/**
 * Which events the current pipeline can actually produce (reader mod + relay + adapter).
 * Anything else is accepted when it arrives, but is listed as missing in the PR.
 */
export const EVENT_SOURCES: Readonly<Record<string, string>> = {
    'day_start:<n>': 'adapter: day counter increase in reader snapshots',
    rent_paid: 'reader: RunStats.OnRentPaid',
    deficit: 'adapter: cash < 0 in reader snapshots',
    deficit_persisted: 'adapter: a new day starts while cash is still < 0',
    deficit_cleared: 'adapter: cash returns to >= 0 in the same run',
    'item_bought:<item>': 'reader: RunStats.OnItemBought',
    investigation_near_threshold: 'adapter (and relay): investigation crosses the configured near threshold',
    investigation_over_threshold: 'adapter: investigation crosses the configured over threshold',
    'npc_arrived:<id>': 'relay: current client changes; security clients map to security_officer',
    'kill:ai_controlled': 'reader: RunStats.OnAugShot',
    'story:<faction>.first_visit': 'relay: present client belongs to the cartel / revolution / church faction',
    first_chem_sale: 'adapter: first sale:<chem item> in the run (needs reader sale events)',
    profit_margin_high: 'adapter: sale facts price/profit exceed the configured ratio (needs reader sale events)',
}

/** Reader scalar state the adapter tracks between snapshots to derive transitions. */
export interface TrackedScalars {
    runId: string
    day: number | null
    cash: number
    investigation: number | null
}

/**
 * Derive threshold and transition events from two consecutive snapshots.
 * `previous` is null (or from another run) for the first snapshot of a run.
 */
export function deriveSnapshotEvents(previous: TrackedScalars | null, next: TrackedScalars, config: SeasonConfig): string[] {
    const events: string[] = []
    const sameRun = previous !== null && previous.runId === next.runId
    if (!sameRun) {
        if (next.day !== null) events.push(`day_start:${next.day}`)
        if (next.cash < 0) events.push('deficit')
        for (const [threshold, tag] of [[config.investigationNear, 'investigation_near_threshold'], [config.investigationOver, 'investigation_over_threshold']] as const) {
            if (next.investigation !== null && next.investigation >= threshold) events.push(tag)
        }
        return events
    }
    const dayStarted = next.day !== null && previous.day !== null && next.day > previous.day
    if (dayStarted) events.push(`day_start:${next.day}`)
    if (next.cash < 0 && previous.cash >= 0) events.push('deficit')
    else if (next.cash < 0 && dayStarted) events.push('deficit_persisted')
    if (next.cash >= 0 && previous.cash < 0) events.push('deficit_cleared')
    for (const [threshold, tag] of [[config.investigationNear, 'investigation_near_threshold'], [config.investigationOver, 'investigation_over_threshold']] as const) {
        if (next.investigation !== null && next.investigation >= threshold && (previous.investigation === null || previous.investigation < threshold)) events.push(tag)
    }
    return events
}

/** Derive sale-related events from one reader sale observation. */
export function deriveSaleEvents(item: string, facts: Readonly<Record<string, unknown>>, chemSoldBefore: boolean, config: SeasonConfig): string[] {
    const events: string[] = []
    if (config.chemItemIds.includes(item) && !chemSoldBefore) events.push('first_chem_sale')
    const price = facts.price
    const profit = facts.profit
    if (typeof price === 'number' && typeof profit === 'number' && price > 0 && profit / price >= config.profitMarginHigh) {
        events.push('profit_margin_high')
    }
    return events
}
