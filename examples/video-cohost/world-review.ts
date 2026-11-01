/**
 * Review queue for the effects of key world events.
 *
 * Every reader event still enters Observation / Situation immediately, so Jingjing
 * can react live. What waits for the owner is the *effect*: advancing script beats
 * and writing story memories. Routine events (day starts, purchases, ordinary
 * visitors) pass straight through. The queue is stored in the instance snapshot.
 */
import type { CharacterWorkspace } from '../../src/runtime/workspace.ts'
import type { Clock } from '../../src/kernel/util/clock.ts'
import { eventMatches } from './season/script.ts'

const STATE_KEY = 'jingjing.worldReview'
const KEEP_DECIDED = 300

export type WorldReviewMode = 'review' | 'auto'

/** Routine events whose effects never wait for review. */
export const REVIEW_PASSTHROUGH = ['day_start:*', 'rent_paid', 'item_bought:*', 'npc_left:*', 'npc_arrived:*']
/** Exceptions to the passthrough list that are always key events. */
export const REVIEW_ALWAYS = ['npc_arrived:security_officer']

export function isRoutineEvent(event: string): boolean {
    return REVIEW_PASSTHROUGH.some(pattern => eventMatches(pattern, event)) && !REVIEW_ALWAYS.some(pattern => eventMatches(pattern, event))
}

export interface WorldEffect {
    ref: string
    runId: string
    events: string[]
    summary: string
    itemName: string
    atSim: number
    source: 'event' | 'snapshot'
}

export interface PendingWorldEffect extends WorldEffect {
    id: string
    status: 'pending' | 'approved' | 'rejected'
    decidedAtSim: number | null
}

interface QueueState {
    mode: WorldReviewMode | null
    seq: number
    items: PendingWorldEffect[]
}

export class WorldEffectReview {
    #workspace: CharacterWorkspace
    #clock: Clock
    #defaultMode: WorldReviewMode

    constructor(workspace: CharacterWorkspace, clock: Clock, defaultMode: WorldReviewMode) {
        this.#workspace = workspace
        this.#clock = clock
        this.#defaultMode = defaultMode
    }

    #state(): QueueState {
        return this.#workspace.extensionState<QueueState>(STATE_KEY) ?? { mode: null, seq: 0, items: [] }
    }

    #save(state: QueueState): void {
        const decided = state.items.filter(item => item.status !== 'pending')
        if (decided.length > KEEP_DECIDED) {
            const drop = new Set(decided.slice(0, decided.length - KEEP_DECIDED).map(item => item.id))
            state.items = state.items.filter(item => !drop.has(item.id))
        }
        this.#workspace.setExtensionState(STATE_KEY, state)
    }

    mode(): WorldReviewMode { return this.#state().mode ?? this.#defaultMode }

    setMode(mode: WorldReviewMode, actorId: string): void {
        const state = this.#state()
        state.mode = mode
        this.#save(state)
        this.#workspace.audit.append('decision', actorId, `世界事件效果审批模式：${mode}`, { mode })
    }

    /** True when this (ref, event) pair is already queued or decided. */
    knows(ref: string, event: string): boolean {
        return this.#state().items.some(item => item.ref === ref && item.events.includes(event))
    }

    enqueue(effect: WorldEffect): PendingWorldEffect {
        const state = this.#state()
        const item: PendingWorldEffect = { ...structuredClone(effect), id: `wrv_${++state.seq}`, status: 'pending', decidedAtSim: null }
        state.items.push(item)
        this.#save(state)
        this.#workspace.audit.append('decision', 'world_review', '关键世界事件的效果进入待审队列', { id: item.id, ref: item.ref, events: item.events })
        return structuredClone(item)
    }

    list(status?: PendingWorldEffect['status']): PendingWorldEffect[] {
        return this.#state().items.filter(item => !status || item.status === status)
    }

    decide(id: string, decision: 'approve' | 'reject', actorId: string): PendingWorldEffect {
        const state = this.#state()
        const item = state.items.find(entry => entry.id === id)
        if (!item) throw new Error(`Unknown pending world effect ${id}`)
        if (item.status !== 'pending') throw new Error(`World effect ${id} is already ${item.status}`)
        item.status = decision === 'approve' ? 'approved' : 'rejected'
        item.decidedAtSim = this.#clock.nowSim()
        this.#save(state)
        this.#workspace.audit.append('decision', actorId, `世界事件效果 ${id}：${item.status}`, { id, ref: item.ref, events: item.events })
        return structuredClone(item)
    }
}
