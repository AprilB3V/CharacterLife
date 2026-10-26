/**
 * 持久层旁路监听：把工作区与记忆区的每一次变更写成 SQLite 行 / 追加事件。
 *
 * 这样做的价值：引擎本身仍然只依赖 `StateSink` / `MemorySink` 两个窄接口，
 * 换存储（JSON、Postgres）不需要改运行时；而 SQLite 这边拿到的是**结构化的、
 * 可重放的事件序列**，而不是一坨快照。
 */

import type { MemoryEntry } from '../types.ts'
import type { MemorySink } from '../kernel/memory/store.ts'
import type { StateSink } from '../runtime/workspace.ts'
import type { PersistedEventType } from './store.ts'
import { CharacterPersistence, MemoryWriteRejected } from './store.ts'
import type { Clock } from '../kernel/util/clock.ts'

export interface SinkOptions {
  persistence: CharacterPersistence
  instanceId: string
  clock: Clock
  /** 当前会话 id；会话切换后需要更新 */
  getSessionId: () => string | null
  /** 遇到非法记忆写入时的审计出口（默认忽略，由 Persistence 记事件） */
  onRejectedWrite?: (reason: string, entry: MemoryEntry) => void
}

export class SqliteSink implements StateSink, MemorySink {
  #persistence: CharacterPersistence
  #instanceId: string
  #clock: Clock
  #getSessionId: () => string | null
  #onRejectedWrite: ((reason: string, entry: MemoryEntry) => void) | null

  constructor(opts: SinkOptions) {
    this.#persistence = opts.persistence
    this.#instanceId = opts.instanceId
    this.#clock = opts.clock
    this.#getSessionId = opts.getSessionId
    this.#onRejectedWrite = opts.onRejectedWrite ?? null
  }

  /* ------------------------------------------------------------- 状态事件 */

  onStateApplied(evt: {
    source: string
    proposals: Array<{
      target: string
      op: string
      path: string
      value: unknown
      reason: string
      evidence: string[]
    }>
    sim: number
    relationshipTouched: boolean
    timeline?: unknown
  }): void {
    this.#append('state_patch', `状态补丁 ${evt.proposals.length} 条（${evt.source}）`, {
      source: evt.source,
      proposals: evt.proposals,
      relationshipTouched: evt.relationshipTouched,
      timeline: evt.timeline,
    })
  }

  onEventFired(evt: { event: unknown; timeline: unknown }): void {
    this.#append('event_fired', '时间线事件触发', {
      event: evt.event,
      timeline: evt.timeline,
    })
  }

  /* ------------------------------------------------------------- 记忆事件 */

  onMemoryWritten(entry: MemoryEntry): void {
    try {
      this.#persistence.insertMemory(this.#instanceId, entry)
    } catch (err) {
      if (err instanceof MemoryWriteRejected) {
        this.#onRejectedWrite?.(err.reason, entry)
        this.#append('memory_write_rejected', `记忆写入被持久层拦截：${err.reason}`, {
          memoryId: entry.id,
          reason: err.reason,
        })
        return
      }
      throw err
    }
  }

  onMemoryDeleted(id: string, atSim: number): void {
    this.#persistence.softDeleteMemory(this.#instanceId, id, atSim)
  }

  #append(type: PersistedEventType, summary: string, data: Record<string, unknown>): void {
    this.#persistence.appendEvent({
      instanceId: this.#instanceId,
      sessionId: this.#getSessionId(),
      type,
      atSim: this.#clock.nowSim(),
      atWall: this.#clock.nowWall().toISOString(),
      actor: 'runtime',
      summary,
      data,
    })
  }
}
