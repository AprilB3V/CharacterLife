/**
 * 虚构时间线与事件调度。
 *
 * 特点：
 * - 事件按 (atSim, order, id) 稳定排序，同一时刻的事件顺序可复现；
 * - `due()` 只返回未触发且已到期的事件，触发后置 fired —— 幂等，
 *   重复调用 `advanceTo` 不会重复触发（这是「可重放」的前提）；
 * - 调度本身不调用模型：时间推进纯粹是确定性代码。
 */

import type { EventKind, TimelineEvent } from '../types.ts'
import type { Clock } from '../util/clock.ts'
import type { IdFactory } from '../util/ids.ts'
import type { SnapshotSection } from '../storage/snapshot.ts'

export interface ScheduleInput {
  atSim: number
  kind: EventKind
  title: string
  description: string
  payload?: Record<string, unknown>
  /** 同一时间戳下的顺序（小者先触发） */
  order?: number
}

export class Timeline implements SnapshotSection {
  readonly sectionName = 'timeline'
  #events: TimelineEvent[] = []
  #clock: Clock
  #ids: IdFactory
  /** 每次结构性变更 +1；持久层用它判断「时间线是否变了，需要随事件一起落库」 */
  #version = 0

  constructor(clock: Clock, ids: IdFactory, initial: TimelineEvent[] = []) {
    this.#clock = clock
    this.#ids = ids
    this.#events = initial.map((e) => ({ ...e, payload: { ...e.payload } }))
  }

  get version(): number {
    return this.#version
  }

  schedule(input: ScheduleInput): TimelineEvent {
    // 幂等：同名事件只排一次（重启后再次 schedule 也不会重复）。
    const existing = this.#events.find((e) => e.title === input.title)
    if (existing) return { ...existing, payload: { ...existing.payload } }
    const event: TimelineEvent = {
      id: this.#ids.next('evt'),
      kind: input.kind,
      atSim: input.atSim,
      order: input.order ?? 100,
      title: input.title,
      description: input.description,
      fired: false,
      firedAtSim: null,
      payload: { ...(input.payload ?? {}) },
    }
    this.#events.push(event)
    this.#sort()
    this.#version++
    return { ...event, payload: { ...event.payload } }
  }

  /** 已到期、尚未触发的事件，按时间顺序。 */
  due(nowSim: number): TimelineEvent[] {
    return this.#events
      .filter((e) => !e.fired && e.atSim <= nowSim)
      .sort(compareEvents)
      .map((e) => ({ ...e, payload: { ...e.payload } }))
  }

  markFired(id: string, nowSim: number = this.#clock.nowSim()): boolean {
    const event = this.#events.find((e) => e.id === id)
    if (!event || event.fired) return false
    event.fired = true
    event.firedAtSim = nowSim
    this.#version++
    return true
  }

  list(opts: { includeFired?: boolean } = {}): TimelineEvent[] {
    const items = opts.includeFired === false ? this.#events.filter((e) => !e.fired) : this.#events
    return items.sort(compareEvents).map((e) => ({ ...e, payload: { ...e.payload } }))
  }

  pending(nowSim: number): TimelineEvent[] {
    return this.#events.filter((e) => !e.fired && e.atSim > nowSim).sort(compareEvents)
  }

  get size(): number {
    return this.#events.length
  }

  toJSON(): unknown {
    return this.#events.map((e) => ({ ...e, payload: { ...e.payload } }))
  }

  fromJSON(value: unknown): void {
    if (!Array.isArray(value)) throw new Error('timeline section 必须是数组')
    this.#events = (value as TimelineEvent[]).map((e) => ({ ...e, payload: { ...e.payload } }))
    this.#version++
  }

  #sort(): void {
    this.#events.sort(compareEvents)
  }
}

function compareEvents(a: TimelineEvent, b: TimelineEvent): number {
  return a.atSim - b.atSim || a.order - b.order || a.id.localeCompare(b.id)
}
