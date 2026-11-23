/**
 * Agenda · the character's own to-do list, sorted into four quadrants (urgent × important).
 *
 * Items come from two places:
 *   - runtime-managed: open commitments, urgent drives and unfinished dynamic goals are mirrored
 *     here on every sync and closed by the runtime when their source closes;
 *   - self: the Mind may add its own items, drop or re-sort them (a few ops per wake).
 *
 * Rules (M1 constraint C): an item is only "done" with world evidence. A self item is closed only by
 * an explicit `done` op that cites a succeeded action created after the item; a linked action that
 * succeeded just leaves a note (agenda v2: the world confirms the action, not the item's content). Runtime-managed items close only when their source does (commitment settled, drive
 * relieved, goal finished). Urgency of a dated item is computed from its due time, never chosen by
 * the model; importance is the character's own judgement.
 *
 * The state is plain JSON (`AgendaState`), persisted through an `AgendaStore` (for a workspace:
 * an extension-state key), so a character rebuilt from storage keeps its list.
 */

import type { CharacterGoal, Commitment } from '../types.ts'
import type { DriveReading } from './drives.ts'
import { DAY, HOUR, formatSim } from '../util/clock.ts'
import { sanitizeForMemory } from '../util/text.ts'

export const AGENDA_STATE_VERSION = 1
/** Open items the list may hold; adds beyond it are rejected */
export const AGENDA_MAX_OPEN = 8
/** A dated item becomes urgent this long before it is due */
export const AGENDA_URGENT_WINDOW_MS = 2 * HOUR
/** Ops the Mind may submit per wake; the rest are ignored */
export const AGENDA_MAX_OPS = 3
export const AGENDA_TEXT_MAX = 40
/** Unfinished goals mirrored into the agenda */
export const AGENDA_MAX_GOALS = 3
const NOTES_KEPT = 3
const CLOSED_KEPT = 20

export type AgendaSource = 'commitment' | 'drive' | 'goal' | 'self'
export type AgendaStatus = 'open' | 'done' | 'dropped'

export interface AgendaLink {
    actionId: string
    settled: boolean
}

export interface AgendaItem {
    id: string
    text: string
    source: AgendaSource
    /** commitment id / drive name / goal id; null for self items */
    sourceRef: string | null
    important: boolean
    /** Only used when there is no due time */
    urgent: boolean
    dueAtSim: number | null
    status: AgendaStatus
    createdAtSim: number
    closedAtSim: number | null
    /** What closed it: a succeeded action id, or `commitment:` / `drive:` / `goal:` + ref */
    evidenceRef: string | null
    /** Short structural notes, newest last (e.g. a linked action failed) */
    notes: string[]
    links: AgendaLink[]
}

export interface AgendaState {
    version: number
    seq: number
    items: AgendaItem[]
}

export interface AgendaStore {
    load(): AgendaState | null
    save(state: AgendaState): void
}

export type AgendaOp =
    | { op: 'add'; text: string; important?: boolean; urgent?: boolean; due?: string | null }
    | { op: 'drop'; id: string; reason?: string }
    | { op: 'move'; id: string; important?: boolean; urgent?: boolean; reason?: string }
    | { op: 'done'; id: string; evidence: string }

export interface AgendaOpResult {
    op: AgendaOp
    ok: boolean
    /** Item touched (new id for add) */
    id: string | null
    /** Why it was rejected */
    code: string | null
}

export interface AgendaChange {
    kind: 'opened' | 'closed' | 'noted' | 'linked'
    id: string
    source: AgendaSource
    detail: string
}

/** Minimal view of a world action, enough to check evidence and reconcile links. */
export interface AgendaActionView {
    actionId: string
    verb: string
    target: string | null
    status: string
    createdAtSim: number
}

export interface AgendaLine {
    id: string
    text: string
    source: AgendaSource
    due: string | null
    notes: string[]
}

export interface AgendaView {
    urgentImportant: AgendaLine[]
    important: AgendaLine[]
    urgent: AgendaLine[]
    other: AgendaLine[]
}

const SETTLED = new Set(['succeeded', 'failed', 'rejected', 'expired'])
const STATUS_TEXT: Record<string, string> = { succeeded: '成功', failed: '失败', rejected: '被世界拒绝', expired: '没有发生' }

function cleanText(text: string): string {
    return sanitizeForMemory(text, AGENDA_TEXT_MAX * 2).replace(/\s+/g, ' ').trim().slice(0, AGENDA_TEXT_MAX)
}

function actionLabel(a: AgendaActionView): string {
    return `${a.verb}(${a.target ?? '*'})`
}

/** "HH:MM" on the current sim day; null when unparseable or already past. */
export function parseDue(raw: string | null | undefined, nowSim: number): number | null {
    if (typeof raw !== 'string') return null
    const m = /^\s*(\d{1,2})[:：](\d{2})\s*$/.exec(raw)
    if (!m) return null
    const h = Number(m[1])
    const min = Number(m[2])
    if (h > 23 || min > 59) return null
    const at = Math.floor(nowSim / DAY) * DAY + h * HOUR + min * 60_000
    return at > nowSim ? at : null
}

export class Agenda {
    #state: AgendaState
    #store: AgendaStore | null

    constructor(opts: { store?: AgendaStore | null } = {}) {
        this.#store = opts.store ?? null
        const loaded = this.#store?.load() ?? null
        this.#state = loaded && loaded.version === AGENDA_STATE_VERSION
            ? structuredClone(loaded)
            : { version: AGENDA_STATE_VERSION, seq: 0, items: [] }
    }

    state(): AgendaState {
        return structuredClone(this.#state)
    }

    open(): AgendaItem[] {
        return structuredClone(this.#state.items.filter((i) => i.status === 'open'))
    }

    get(id: string): AgendaItem | null {
        const item = this.#state.items.find((i) => i.id === id)
        return item ? structuredClone(item) : null
    }

    isUrgent(item: AgendaItem, nowSim: number): boolean {
        return item.dueAtSim !== null ? item.dueAtSim - nowSim <= AGENDA_URGENT_WINDOW_MS : item.urgent
    }

    view(nowSim: number): AgendaView {
        const out: AgendaView = { urgentImportant: [], important: [], urgent: [], other: [] }
        const open = this.#state.items
            .filter((i) => i.status === 'open')
            .sort((a, b) => (a.dueAtSim ?? Infinity) - (b.dueAtSim ?? Infinity) || a.createdAtSim - b.createdAtSim)
        for (const item of open) {
            const line: AgendaLine = {
                id: item.id,
                text: item.text,
                source: item.source,
                due: item.dueAtSim === null ? null : formatSim(item.dueAtSim),
                notes: [...item.notes],
            }
            const urgent = this.isUrgent(item, nowSim)
            if (urgent && item.important) out.urgentImportant.push(line)
            else if (item.important) out.important.push(line)
            else if (urgent) out.urgent.push(line)
            else out.other.push(line)
        }
        return out
    }

    /**
     * Mirror runtime sources: open commitments, urgent drives, unfinished goals. Items whose source
     * has closed are closed with the source as evidence.
     */
    sync(input: { nowSim: number; commitments: readonly Commitment[]; drives: readonly DriveReading[]; goals: readonly CharacterGoal[] }): AgendaChange[] {
        const changes: AgendaChange[] = []
        const now = input.nowSim
        const wanted = new Map<string, { source: AgendaSource; ref: string; text: string; dueAtSim: number | null; important: boolean; urgent: boolean }>()
        for (const c of input.commitments) {
            if (c.status !== 'open') continue
            wanted.set(`commitment:${c.id}`, { source: 'commitment', ref: c.id, text: c.text, dueAtSim: c.dueAtSim, important: true, urgent: false })
        }
        for (const d of input.drives) {
            if (!d.urgent) continue
            wanted.set(`drive:${d.name}`, { source: 'drive', ref: d.name, text: `缓解${d.label}`, dueAtSim: null, important: true, urgent: true })
        }
        // Runtime items are real obligations and are not subject to AGENDA_MAX_OPEN (that caps the
        // Mind's own adds); goals are the only unbounded source, so only the first few are mirrored.
        const mirrored = new Set(this.#state.items.filter((i) => i.status === 'open' && i.source === 'goal').map((i) => i.sourceRef))
        const unfinished = input.goals.filter((x) => x.progress < 1)
        let goalSlots = AGENDA_MAX_GOALS - unfinished.filter((g) => mirrored.has(g.id)).length
        for (const g of unfinished) {
            if (!mirrored.has(g.id) && goalSlots-- <= 0) continue
            wanted.set(`goal:${g.id}`, { source: 'goal', ref: g.id, text: g.title, dueAtSim: null, important: true, urgent: false })
        }

        for (const item of this.#state.items) {
            if (item.status !== 'open' || item.source === 'self') continue
            const key = `${item.source}:${item.sourceRef}`
            if (wanted.has(key)) {
                wanted.delete(key)
                continue
            }
            // Source closed. A commitment that left the open set was settled (kept or broken) by the
            // runtime; a drive stopped being urgent only through a world-confirmed relief.
            const settled = item.source === 'commitment' ? input.commitments.find((c) => c.id === item.sourceRef) : null
            const goal = item.source === 'goal' ? input.goals.find((g) => g.id === item.sourceRef) : null
            // A broken promise or a goal that disappeared unfinished is not "done".
            item.status = settled?.status === 'broken' || (item.source === 'goal' && !(goal && goal.progress >= 1)) ? 'dropped' : 'done'
            item.closedAtSim = now
            item.evidenceRef = key
            changes.push({ kind: 'closed', id: item.id, source: item.source, detail: `${item.status}:${key}` })
        }

        for (const [key, w] of wanted) {
            const item = this.#newItem(now, { text: cleanText(w.text), source: w.source, sourceRef: w.ref, important: w.important, urgent: w.urgent, dueAtSim: w.dueAtSim })
            changes.push({ kind: 'opened', id: item.id, source: w.source, detail: key })
        }
        if (changes.length > 0) this.#commit()
        return changes
    }

    /** Settle links to world actions: every settled link leaves a note; none closes an item. */
    reconcile(actions: readonly AgendaActionView[]): AgendaChange[] {
        const changes: AgendaChange[] = []
        const byId = new Map(actions.map((a) => [a.actionId, a]))
        for (const item of this.#state.items) {
            for (const link of [...item.links]) {
                if (link.settled) continue
                const action = byId.get(link.actionId)
                if (!action || !SETTLED.has(action.status)) continue
                // Settled links are dropped (the note or evidenceRef keeps what matters), so links stay bounded.
                item.links = item.links.filter((l) => l.actionId !== link.actionId)
                if (item.status !== 'open') continue
                // A succeeded link is not completion: the world confirmed the action, not the item's
                // content (agenda v1 review: "find food" was closed by talking to someone). It leaves a
                // note with the action id; the Mind closes the item with an explicit `done` citing it.
                const id = action.status === 'succeeded' ? ` [${action.actionId}]` : ''
                const note = `${actionLabel(action)} ${STATUS_TEXT[action.status] ?? action.status}${id}`
                item.notes = [...item.notes, note].slice(-NOTES_KEPT)
                changes.push({ kind: 'noted', id: item.id, source: item.source, detail: note })
            }
        }
        if (changes.length > 0) this.#commit()
        return changes
    }

    /** Link an admitted world action to an open item (the Mind said the action is for it). */
    link(id: string, actionId: string): boolean {
        const item = this.#state.items.find((i) => i.id === id && i.status === 'open')
        if (!item || item.links.some((l) => l.actionId === actionId)) return false
        item.links.push({ actionId, settled: false })
        this.#commit()
        return true
    }

    /** Apply the Mind's ops (model output: untrusted, validated one by one). */
    apply(ops: readonly AgendaOp[], ctx: { nowSim: number; actions: readonly AgendaActionView[] }): AgendaOpResult[] {
        const results: AgendaOpResult[] = []
        for (const op of ops.slice(0, AGENDA_MAX_OPS)) results.push(this.#applyOne(op, ctx))
        for (const op of ops.slice(AGENDA_MAX_OPS)) results.push({ op, ok: false, id: null, code: 'too_many_ops' })
        if (results.some((r) => r.ok)) this.#commit()
        return results
    }

    #applyOne(op: AgendaOp, ctx: { nowSim: number; actions: readonly AgendaActionView[] }): AgendaOpResult {
        const reject = (code: string, id: string | null = null): AgendaOpResult => ({ op, ok: false, id, code })
        const open = this.#state.items.filter((i) => i.status === 'open')
        if (op.op === 'add') {
            const text = cleanText(op.text ?? '')
            if (text.length === 0) return reject('empty_text')
            if (open.length >= AGENDA_MAX_OPEN) return reject('list_full')
            if (open.some((i) => i.text === text)) return reject('duplicate')
            const item = this.#newItem(ctx.nowSim, {
                text,
                source: 'self',
                sourceRef: null,
                important: op.important !== false,
                urgent: op.urgent === true,
                dueAtSim: parseDue(op.due, ctx.nowSim),
            })
            return { op, ok: true, id: item.id, code: null }
        }
        const item = open.find((i) => i.id === op.id)
        if (!item) return reject('unknown_or_closed', op.id ?? null)
        if (op.op === 'move') {
            if (typeof op.important === 'boolean') item.important = op.important
            if (typeof op.urgent === 'boolean' && item.dueAtSim === null) item.urgent = op.urgent
            return { op, ok: true, id: item.id, code: null }
        }
        // Runtime-managed items close only when their source does.
        if (item.source !== 'self') return reject('runtime_managed', item.id)
        if (op.op === 'drop') {
            item.status = 'dropped'
            item.closedAtSim = ctx.nowSim
            if (op.reason) item.notes = [...item.notes, cleanText(op.reason)].slice(-NOTES_KEPT)
            return { op, ok: true, id: item.id, code: null }
        }
        if (op.op === 'done') {
            const action = ctx.actions.find((a) => a.actionId === op.evidence)
            // Strictly after the item: an action from the same instant may predate it (review, 2026-11-20).
            if (!action || action.status !== 'succeeded' || action.createdAtSim <= item.createdAtSim) return reject('no_world_evidence', item.id)
            item.status = 'done'
            item.closedAtSim = ctx.nowSim
            item.evidenceRef = action.actionId
            return { op, ok: true, id: item.id, code: null }
        }
        return reject('unknown_op')
    }

    #newItem(nowSim: number, fields: Pick<AgendaItem, 'text' | 'source' | 'sourceRef' | 'important' | 'urgent' | 'dueAtSim'>): AgendaItem {
        this.#state.seq += 1
        const item: AgendaItem = {
            id: `ag_${String(this.#state.seq).padStart(3, '0')}`,
            ...fields,
            status: 'open',
            createdAtSim: nowSim,
            closedAtSim: null,
            evidenceRef: null,
            notes: [],
            links: [],
        }
        this.#state.items.push(item)
        return item
    }

    #commit(): void {
        // Keep every open item and only the most recent closed ones.
        const closed = this.#state.items.filter((i) => i.status !== 'open')
        if (closed.length > CLOSED_KEPT) {
            const drop = new Set(closed.slice(0, closed.length - CLOSED_KEPT).map((i) => i.id))
            this.#state.items = this.#state.items.filter((i) => !drop.has(i.id))
        }
        this.#store?.save(structuredClone(this.#state))
    }
}
