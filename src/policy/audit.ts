/**
 * 审计日志。
 *
 * 所有状态变更、被拒绝的提议、注入检测、安全降级都落到这里。
 * 设计目标：复盘「角色为什么变成这样」时，能按时间顺序看到完整证据链。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Clock } from '../util/clock.ts'

export type AuditEventType =
  | 'turn'
  | 'proposal_applied'
  | 'proposal_rejected'
  | 'memory_written'
  | 'memory_deleted'
  | 'profile_write_attempt'
  | 'policy_write_attempt'
  | 'injection_detected'
  | 'event_fired'
  | 'decision'
  | 'boundary_declared'
  | 'world_action'
  | 'snapshot_saved'
  | 'memory_exported'
  | 'provider_error'

export interface AuditEvent {
  seq: number
  atSim: number
  atWall: string
  type: AuditEventType
  actor: string
  summary: string
  data: Record<string, unknown>
}

export class AuditLog {
  #events: AuditEvent[] = []
  #seq = 0
  #filePath: string | null
  #clock: Clock

  constructor(clock: Clock, filePath: string | null = null) {
    this.#clock = clock
    this.#filePath = filePath
    if (filePath) mkdirSync(dirname(filePath), { recursive: true })
  }

  append(type: AuditEventType, actor: string, summary: string, data: Record<string, unknown> = {}): AuditEvent {
    const event: AuditEvent = {
      seq: ++this.#seq,
      atSim: this.#clock.nowSim(),
      atWall: this.#clock.nowWall().toISOString(),
      type,
      actor,
      summary,
      data,
    }
    this.#events.push(event)
    if (this.#filePath) {
      // 审计日志是 append-only JSONL：崩在中间最多丢最后一行，不会破坏已有记录。
      appendFileSync(this.#filePath, `${JSON.stringify(event)}\n`, 'utf8')
    }
    return event
  }

  /** 最近 n 条（默认全部），用于演示与测试断言。 */
  tail(n = this.#events.length): AuditEvent[] {
    return this.#events.slice(Math.max(0, this.#events.length - n))
  }

  filter(type: AuditEventType): AuditEvent[] {
    return this.#events.filter((e) => e.type === type)
  }

  count(type: AuditEventType): number {
    return this.filter(type).length
  }

  get size(): number {
    return this.#events.length
  }
}
