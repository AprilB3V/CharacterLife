/**
 * Thought traces for the owner console.
 *
 * One trace per conversation turn (signals → decision → recall → prompt → model attempts →
 * envelope → outcome) and one per thinking-loop run. Traces live in a per-instance ring buffer
 * in process memory only: they hold prompts and user text, so they are never written to the
 * database or logs, and they are gone after a restart (the ledger keeps the durable summary).
 */
import type { BehaviorDecision, LLMMessage, Usage } from '../kernel/types.ts'
import type { ThinkInput, ThoughtDraft, ThoughtResult } from '../kernel/thinking/types.ts'

/** Long strings are cut so a runaway output cannot grow the buffer without bound. */
export const TRACE_TEXT_CAP = 20_000

export function capText(value: string, cap = TRACE_TEXT_CAP): string {
  return value.length > cap ? `${value.slice(0, cap)}…［截断，原长 ${value.length}］` : value
}

/**
 * Detached, bounded copy of a trace: every string is capped, arrays are cut, depth is limited, and
 * values that cannot be serialised (functions, bigint, cycles) become a marker. Recording never throws.
 */
export function boundedCopy(value: unknown, depth = 0, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value ?? null
  if (typeof value === 'string') return capText(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value !== 'object') return `［${typeof value}］`
  if (seen.has(value) || depth > 12) return '［省略］'
  seen.add(value)
  try {
    if (Array.isArray(value)) {
      const items = value.slice(0, TRACE_ARRAY_CAP).map((item) => boundedCopy(item, depth + 1, seen))
      if (value.length > TRACE_ARRAY_CAP) items.push(`［另有 ${value.length - TRACE_ARRAY_CAP} 项］`)
      return items
    }
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = boundedCopy(item, depth + 1, seen)
    return out
  } finally {
    seen.delete(value)
  }
}

export const TRACE_ARRAY_CAP = 200

export interface TraceMemoryRef {
  id: string
  title: string
  kind?: string
  status?: string
  /** Lexical score, cue keys or tier, depending on the channel */
  detail?: string
}

export interface TurnTraceAttempt {
  raw: string
  rawLength: number
  reasoning: string | null
  reasoningChars: number
  finishReason: string | null
  usage: Usage | null
  latencyMs: number
  /** null when the envelope parsed */
  parseError: string | null
}

export interface TurnTraceMemoryWrite {
  kind: string
  title: string
  content: string
  status: string
  result: 'written' | 'held' | 'skipped'
}

export interface TurnTrace {
  kind: 'turn'
  id: string
  instanceId: string
  /** Pseudonymous platform identity the turn came from */
  identityKey?: string
  turnId: string
  atWall: string
  input: string
  signals: Record<string, unknown> | null
  decision: Pick<BehaviorDecision, 'action' | 'responseStyle' | 'rationale' | 'scores'> | null
  recall: {
    pinned: TraceMemoryRef[]
    retrieved: TraceMemoryRef[]
    cued: TraceMemoryRef[]
    fuzzy: string[]
    /** Memories that actually reached the prompt after budgeting */
    inPrompt: string[]
  } | null
  context: {
    budget: number
    estPromptTokens: number
    degradation: string
    droppedHistoryTurns: number
    droppedMemoryIds: string[]
    digestedTurns: number
  } | null
  prompt: { system: string; messages: LLMMessage[] } | null
  attempts: TurnTraceAttempt[]
  envelope: {
    reply: string
    proposals: unknown[]
    memoryWrites: unknown[]
    worldActions: unknown[]
  } | null
  outcome: {
    reply: string
    /** Why the shown reply is not the model's own, when it is not */
    fallback: string | null
    provider: string
    model: string
    latencyMs: number
    applied: Array<{ id: string; path: string; op: string; value: unknown; reason: string }>
    rejected: Array<{ id: string; path: string; code: string; reason: string }>
    memories: TurnTraceMemoryWrite[]
    blockedReasons: string[]
    error: string | null
  } | null
}

export interface ThinkTrace {
  kind: 'think'
  id: string
  instanceId: string
  atWall: string
  identityKey: string
  inputs: ThinkInput[]
  steps: Array<{ chainDepth: number; latencyMs: number; draft: ThoughtDraft }>
  thought: ThoughtResult
  silent: boolean
}

export type Trace = TurnTrace | ThinkTrace

export interface TraceStoreOptions {
  /** Traces kept per instance (default 100) */
  perInstance?: number
  /** Instances with traces kept at once; the least recently traced is dropped (default 50) */
  maxInstances?: number
}

export class TraceStore {
  readonly perInstance: number
  readonly maxInstances: number
  #byInstance = new Map<string, Trace[]>()
  #seq = 0

  constructor(opts: TraceStoreOptions = {}) {
    this.perInstance = Math.max(1, opts.perInstance ?? 100)
    this.maxInstances = Math.max(1, opts.maxInstances ?? 50)
  }

  nextId(prefix: string): string {
    this.#seq++
    return `${prefix}_${String(this.#seq).padStart(5, '0')}`
  }

  /** Store a detached copy; later changes to the caller's objects do not reach it. Never throws. */
  record(trace: Trace): void {
    let copy: Trace
    try {
      copy = boundedCopy(trace) as Trace
    } catch {
      return
    }
    const list = this.#byInstance.get(trace.instanceId) ?? []
    list.push(copy)
    if (list.length > this.perInstance) list.splice(0, list.length - this.perInstance)
    // Re-insert so Map order is least recently traced first.
    this.#byInstance.delete(trace.instanceId)
    this.#byInstance.set(trace.instanceId, list)
    while (this.#byInstance.size > this.maxInstances) {
      const oldest = this.#byInstance.keys().next().value
      if (oldest === undefined) break
      this.#byInstance.delete(oldest)
    }
  }

  /** Newest first. */
  list(instanceId: string, opts: { limit?: number; kind?: Trace['kind'] } = {}): Trace[] {
    const list = this.#byInstance.get(instanceId) ?? []
    const filtered = opts.kind ? list.filter((t) => t.kind === opts.kind) : list
    return structuredClone(filtered.slice(-(opts.limit ?? this.perInstance)).reverse())
  }

  get(instanceId: string, id: string): Trace | null {
    const found = this.#byInstance.get(instanceId)?.find((t) => t.id === id)
    return found ? structuredClone(found) : null
  }

  has(instanceId: string): boolean {
    return this.#byInstance.has(instanceId)
  }
}
