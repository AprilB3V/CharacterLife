/**
 * Simulated full run for season 1 (《绝命鲸师》), replayed through the real world
 * ingest path. Event names follow examples/video-cohost/season/events.ts; events
 * the reader cannot produce yet (sale, inspection, game_over) are injected here as
 * if the reader had emitted them.
 */
export const RUN = '1:run-s1'
export const OTHER_RUN = '2:run-other'

export interface SnapshotStep {
    label: string
    snapshot: { day: number; cash: number; investigation: number; items?: Array<[string, string, string, number]> }
}

export interface EventStep {
    label: string
    event: string
    facts?: Record<string, string | number | boolean>
    runId?: string
}

export type FixtureStep = SnapshotStep | EventStep

export const SEASON_ONE_RUN: FixtureStep[] = [
    // Prologue: broke start with a deficit.
    { label: 'day1', snapshot: { day: 1, cash: -200, investigation: 5 } },
    // A relay threshold event before the profit turn must not enter act 3.
    { label: 'early-heat', event: 'investigation_near_threshold' },
    // Act 1: scavenging while the deficit persists.
    { label: 'day2', snapshot: { day: 2, cash: -150, investigation: 10 } },
    { label: 'scavenge', event: 'item_bought:scrap_metal', facts: { amount: 20, itemName: '废铁' } },
    { label: 'debt-free', snapshot: { day: 2, cash: 60, investigation: 12, items: [['reducer', '还原剂', 'store', 1]] } },
    // Act 2: first chemical sale with a high margin.
    { label: 'chem-sale', event: 'sale:dream_dust', facts: { price: 400, profit: 300 } },
    // Act 3: heat rises, the officer knocks, the inspection passes.
    { label: 'heat-75', snapshot: { day: 3, cash: 460, investigation: 76 } },
    { label: 'heat-80', snapshot: { day: 3, cash: 460, investigation: 81 } },
    { label: 'officer', event: 'npc_arrived:security_officer' },
    { label: 'inspection', event: 'inspection_passed', facts: { amount: 0 } },
    // Cross-cutting grudge line, plus a story seen only in another run.
    { label: 'kill-1', event: 'kill:ai_controlled', facts: { amount: 1 } },
    { label: 'story-other-run', event: 'story:cartel.first_visit', runId: OTHER_RUN },
    { label: 'kill-2', event: 'kill:ai_controlled', facts: { amount: 1 } },
    // Act 4: an outside faction shows up in this run.
    { label: 'story', event: 'story:cartel.first_visit' },
    // Failure branch: back in the red, then bankrupt. Nothing advances afterwards.
    { label: 'day4', snapshot: { day: 4, cash: -30, investigation: 40 } },
    { label: 'bankrupt', event: 'game_over:bankrupt' },
    { label: 'after-end', event: 'store_bought' },
]
