/**
 * Review queue for model-proposed memories.
 *
 * When enabled, memories the chat model proposes in a turn are held here instead of
 * being written. An owner approves or rejects them in the console; approval writes
 * through the same Policy path with the original actor and source turn, so approval
 * never grants the model more authority than an immediate write would have had.
 *
 * Runtime memories backed by world evidence are not held (they keep their own path).
 * The queue lives in the instance snapshot (`extensions['cl.memoryReview']`).
 */
import type { CharacterWorkspace } from './workspace.ts'
import type { MemoryWriteInput } from '../kernel/memory/store.ts'
import type { Clock } from '../kernel/util/clock.ts'
import { CONVERSATION_ACTOR } from '../kernel/policy/policy.ts'

const STATE_KEY = 'cl.memoryReview'
const KEEP_DECIDED = 200

export type MemoryReviewMode = 'off' | 'model'

export interface PendingMemory {
    id: string
    input: MemoryWriteInput
    sourceRef: string
    proposedAtSim: number
    status: 'pending' | 'approved' | 'rejected'
    decidedAtSim: number | null
    entryId: string | null
    note: string | null
}

interface QueueState {
    seq: number
    items: PendingMemory[]
}

export class MemoryReviewQueue {
    #workspace: CharacterWorkspace
    #clock: Clock

    constructor(workspace: CharacterWorkspace, clock: Clock) {
        this.#workspace = workspace
        this.#clock = clock
    }

    #state(): QueueState {
        return this.#workspace.extensionState<QueueState>(STATE_KEY) ?? { seq: 0, items: [] }
    }

    #save(state: QueueState): void {
        const decided = state.items.filter(item => item.status !== 'pending')
        if (decided.length > KEEP_DECIDED) {
            const drop = new Set(decided.slice(0, decided.length - KEEP_DECIDED).map(item => item.id))
            state.items = state.items.filter(item => !drop.has(item.id))
        }
        this.#workspace.setExtensionState(STATE_KEY, state)
    }

    hold(input: MemoryWriteInput, sourceRef: string): PendingMemory {
        const state = this.#state()
        const item: PendingMemory = { id: `mrv_${++state.seq}`, input: structuredClone(input), sourceRef,
            proposedAtSim: this.#clock.nowSim(), status: 'pending', decidedAtSim: null, entryId: null, note: null }
        state.items.push(item)
        this.#save(state)
        this.#workspace.audit.append('decision', 'memory_review', '模型提出的记忆进入待审队列', { id: item.id, sourceRef, title: input.title })
        return structuredClone(item)
    }

    list(status?: PendingMemory['status']): PendingMemory[] {
        return this.#state().items.filter(item => !status || item.status === status)
    }

    /** Approve or reject a held memory. Approval writes with the original conversation actor. */
    decide(id: string, decision: 'approve' | 'reject', actorId: string): PendingMemory {
        const state = this.#state()
        const item = state.items.find(entry => entry.id === id)
        if (!item) throw new Error(`Unknown pending memory ${id}`)
        if (item.status !== 'pending') throw new Error(`Memory ${id} is already ${item.status}`)
        item.decidedAtSim = this.#clock.nowSim()
        if (decision === 'approve') {
            const result = this.#workspace.writeMemory(item.input, CONVERSATION_ACTOR, item.sourceRef)
            item.status = result.written ? 'approved' : 'rejected'
            item.entryId = result.entryId
            item.note = result.written ? null : `Policy 拒绝写入：${result.verdict}`
        } else {
            item.status = 'rejected'
        }
        this.#save(state)
        this.#workspace.audit.append('decision', actorId, `待审记忆 ${id}：${item.status}`, { id, sourceRef: item.sourceRef, entryId: item.entryId })
        return structuredClone(item)
    }
}
