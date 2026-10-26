/**
 * TextWorld：无画面的 CL-World（确定性小镇模拟器）。
 *
 * 它和 Godot 箱庭扮演**同一个角色**：从 WorldService 领取动作、执行、上报回执与观察。
 * 走的是同一套契约（lease / ingest / WorldEvent），只是不经过 HTTP、没有画面。
 * 因此实验在这里跑，演示时换成 Godot，角色引擎一侧不需要改任何东西。
 *
 * 世界里有：
 *   三个地点  workshop（工作室）/ bakery（面包房）/ plaza（广场）
 *   两个 NPC  林姐（面包房，午休离开）、周老师（下午在广场下棋，时间有抖动）
 *   一处稀缺  面包每天早上补货，别的客人陆续买走，午后多半卖完
 *   一个摊位  广场旧货摊，白天开
 *
 * 感知限制：角色只能观察到**自己所在地点**发生的事。
 * 它不在面包房时，面包卖完了它不会知道 —— 直到它去了、买失败了。
 *
 * 世界还保留一份完整的**真值日志**（truth），记录每一次状态变化与因果，
 * 供事后核对角色的信念与归因。角色看不到这份日志。
 */

import type { WorldService } from '../../src/kernel/world/service.ts'
import type { WorldActionView } from '../../src/kernel/world/contracts.ts'
import type { Clock } from '../../src/kernel/util/clock.ts'
import { HOUR } from '../../src/kernel/util/clock.ts'
import type { Rng } from '../../src/kernel/util/rng.ts'

export const PLACES = ['workshop', 'bakery', 'plaza'] as const
export type Place = (typeof PLACES)[number]

const MINUTE = 60_000

const PLACE_NAMES: Record<Place, string> = { workshop: '工作室', bakery: '面包房', plaza: '广场' }

/** 各动作耗时（模拟分钟） */
const DURATION_MIN: Record<string, number> = {
  move_to: 15,
  buy: 5,
  eat: 15,
  talk_to: 30,
  repair: 60,
  browse: 40,
  rest: 60,
}

export interface TruthRecord {
  t: number
  kind: string
  detail: Record<string, unknown>
}

interface Running {
  action: WorldActionView
  startAt: number
  endAt: number
}

export interface TextWorldOptions {
  world: WorldService
  worldId: string
  instanceId: string
  clock: Clock
  rng: Rng
  /** 角色起始位置 */
  start?: Place
  /** 每天早上补货的面包数量 */
  breadStock?: number
}

/** 一天中的时刻（小时，可带小数），模拟时间从 Day1 00:00 起算。 */
function hourOfDay(sim: number): number {
  return (sim % (24 * HOUR)) / HOUR
}

export class TextWorld {
  readonly truth: TruthRecord[] = []
  #o: TextWorldOptions
  #location: Place
  #inventory = { bread: 0 }
  #stock: number
  #stockDay = -1
  #running: Running | null = null
  #eventSeq = 0
  /** 周老师当天的到场/离场时刻（小时），每天按种子抖动 */
  #zhouWindow = { from: 14, to: 17 }
  /** 其他客人买面包的时刻（小时），每天按种子生成 */
  #customerTimes: number[] = []
  #prevPresence: Record<string, boolean> = {}
  #prevStallOpen = false
  #initialized = false

  constructor(opts: TextWorldOptions) {
    this.#o = opts
    this.#location = opts.start ?? 'workshop'
    this.#stock = 0
  }

  get location(): Place {
    return this.#location
  }

  get inventory(): { bread: number } {
    return { ...this.#inventory }
  }

  get stock(): number {
    return this.#stock
  }

  /* ------------------------------------------------------------ 世界规则 */

  #rollDay(day: number): void {
    if (day === this.#stockDay) return
    this.#stockDay = day
    this.#stock = this.#o.breadStock ?? 6
    const jitter = (): number => (this.#o.rng.int(61) - 30) / 60 // ±30 分钟
    this.#zhouWindow = { from: 14 + jitter(), to: 17 + jitter() }
    // 其他客人：7:30 起每 40~90 分钟来一位，每人买一块
    this.#customerTimes = []
    let h = 7.5
    while (h < 19) {
      this.#customerTimes.push(h)
      h += (40 + this.#o.rng.int(51)) / 60
    }
    this.#truth('day_rolled', { day, stock: this.#stock, zhou: this.#zhouWindow, customers: this.#customerTimes.length })
  }

  #bakeryOpen(h: number): boolean {
    return h >= 7 && h < 19
  }

  #stallOpen(h: number): boolean {
    return h >= 10 && h < 16
  }

  /** NPC 此刻在哪里（真值）。 */
  npcAt(npc: string, sim: number): Place | null {
    const h = hourOfDay(sim)
    if (npc === 'npc_lin') {
      if (!this.#bakeryOpen(h)) return null
      if (h >= 12 && h < 13) return null // 午休
      return 'bakery'
    }
    if (npc === 'npc_zhou') {
      return h >= this.#zhouWindow.from && h < this.#zhouWindow.to ? 'plaza' : null
    }
    return null
  }

  #presentAt(place: Place, sim: number): string[] {
    return ['npc_lin', 'npc_zhou'].filter((n) => this.npcAt(n, sim) === place)
  }

  /** 此地此刻真正能做的事（真值；角色只能通过观察得知）。 */
  affordsAt(place: Place, sim: number): string[] {
    const h = hourOfDay(sim)
    const out: string[] = []
    for (const p of PLACES) if (p !== place) out.push(`move_to(${p})`)
    if (place === 'workshop') out.push('repair(old_book)', 'rest(bed)')
    if (place === 'bakery' && this.#bakeryOpen(h) && this.#stock > 0) out.push('buy(bread)')
    if (place === 'plaza' && this.#stallOpen(h)) out.push('browse(stall)')
    for (const npc of this.#presentAt(place, sim)) out.push(`talk_to(${npc})`)
    if (this.#inventory.bread > 0) out.push('eat(bread)')
    return out
  }

  /** 开始执行前的前置条件。返回 null 表示可以开始，否则是拒绝原因（错误码）。 */
  #precondition(action: WorldActionView, sim: number): string | null {
    const h = hourOfDay(sim)
    switch (action.verb) {
      case 'move_to':
        return action.target === this.#location ? 'ALREADY_THERE' : null
      case 'buy':
        if (this.#location !== 'bakery') return 'NOT_AT_BAKERY'
        if (!this.#bakeryOpen(h)) return 'BAKERY_CLOSED'
        return this.#stock > 0 ? null : 'SOLD_OUT'
      case 'eat':
        return this.#inventory.bread > 0 ? null : 'NOTHING_TO_EAT'
      case 'talk_to':
        return this.npcAt(action.target ?? '', sim) === this.#location ? null : 'NOT_PRESENT'
      case 'repair':
      case 'rest':
        return this.#location === 'workshop' ? null : 'NOT_AT_WORKSHOP'
      case 'browse':
        if (this.#location !== 'plaza') return 'NOT_AT_PLAZA'
        return this.#stallOpen(h) ? null : 'STALL_CLOSED'
      default:
        return 'UNKNOWN_VERB'
    }
  }

  /* ------------------------------------------------------------ 事件上报 */

  #nextEventId(): string {
    this.#eventSeq += 1
    return `tw_${String(this.#eventSeq).padStart(5, '0')}`
  }

  #truth(kind: string, detail: Record<string, unknown>): void {
    this.truth.push({ t: this.#o.clock.nowSim(), kind, detail })
  }

  #ingest(events: unknown[]): void {
    const result = this.#o.world.ingest(this.#o.worldId, events)
    if (result.rejected.length > 0) {
      // 世界自己的上报被拒，说明协议实现有错：直接暴露，不要悄悄吞掉
      throw new Error(`TextWorld 上报被拒：${JSON.stringify(result.rejected)}`)
    }
  }

  /** 角色此刻能感知到的快照（只含自己所在地点）。 */
  #snapshotFacts(sim: number): Array<{ key: string; value: string | number | boolean }> {
    const facts: Array<{ key: string; value: string | number | boolean }> = [
      { key: 'snapshot', value: true },
      { key: 'location', value: this.#location },
      { key: 'inventory.bread', value: this.#inventory.bread },
    ]
    for (const npc of this.#presentAt(this.#location, sim)) facts.push({ key: 'present', value: npc })
    for (const a of this.affordsAt(this.#location, sim)) facts.push({ key: 'affords', value: a })
    return facts
  }

  #observe(sim: number, summary: string, events: string[]): void {
    const facts = this.#snapshotFacts(sim)
    for (const e of events) facts.push({ key: 'event', value: e })
    this.#ingest([
      {
        eventId: this.#nextEventId(),
        instanceId: this.#o.instanceId,
        actionId: null,
        kind: 'observation',
        result: null,
        atWorldTimeMs: sim,
        summary,
        facts,
      },
    ])
  }

  #settle(action: WorldActionView, result: 'succeeded' | 'failed' | 'rejected', code: string | null, summary: string): void {
    const sim = this.#o.clock.nowSim()
    this.#ingest([
      {
        eventId: this.#nextEventId(),
        instanceId: this.#o.instanceId,
        actionId: action.actionId,
        kind: 'action_result',
        result,
        atWorldTimeMs: sim,
        summary,
        code,
      },
    ])
    this.#truth('action_settled', { actionId: action.actionId, verb: action.verb, target: action.target, result, code })
    // 动作结束后角色重新"看一眼"周围：一条不带 event 的快照观察（更新处境，不进长期记忆）
    this.#observe(sim, `在${PLACE_NAMES[this.#location]}`, [])
  }

  /* ------------------------------------------------------------ 推进 */

  /** 推进到当前时钟时刻：结算到期动作 → 世界自身变化 → 领取新动作。 */
  step(): void {
    const sim = this.#o.clock.nowSim()
    const day = Math.floor(sim / (24 * HOUR))
    this.#rollDay(day)
    const h = hourOfDay(sim)

    if (!this.#initialized) {
      this.#initialized = true
      this.#prevPresence = Object.fromEntries(['npc_lin', 'npc_zhou'].map((n) => [n, this.npcAt(n, sim) === this.#location]))
      this.#prevStallOpen = this.#stallOpen(h)
      this.#observe(sim, `在${PLACE_NAMES[this.#location]}，一天开始了`, [])
    }

    // 1) 其他客人买面包（真值，角色不在场时无从得知）
    while (this.#customerTimes.length > 0 && this.#customerTimes[0]! <= h) {
      this.#customerTimes.shift()
      if (this.#bakeryOpen(h) && this.#stock > 0) {
        this.#stock -= 1
        this.#truth('customer_bought', { stockLeft: this.#stock })
        if (this.#stock === 0 && this.#location === 'bakery') {
          this.#observe(sim, '最后一块面包被前面的客人买走了', ['stock_out:bread'])
        }
      }
    }

    // 2) 结算到期动作
    if (this.#running && sim >= this.#running.endAt) {
      const { action } = this.#running
      this.#running = null
      this.#complete(action, sim)
    }

    // 3) 角色所在地点的变化（有人来/走、摊位开/收）
    const events: string[] = []
    for (const npc of ['npc_lin', 'npc_zhou']) {
      const here = this.npcAt(npc, sim) === this.#location
      if (here !== this.#prevPresence[npc]) events.push(`${here ? 'npc_arrived' : 'npc_left'}:${npc}`)
      this.#prevPresence[npc] = here
    }
    const stallOpen = this.#stallOpen(h)
    if (stallOpen !== this.#prevStallOpen && this.#location === 'plaza') {
      events.push(stallOpen ? 'stall_open:stall' : 'stall_closed:stall')
    }
    this.#prevStallOpen = stallOpen
    if (events.length > 0) {
      this.#truth('perceived_change', { at: this.#location, events })
      this.#observe(sim, describeEvents(events), events)
    }

    // 4) 空闲时领取下一个动作（一次一个）
    if (this.#running === null) {
      const [next] = this.#o.world.lease(this.#o.worldId, 1)
      if (next) this.#start(next, sim)
    }
  }

  #start(action: WorldActionView, sim: number): void {
    const refusal = this.#precondition(action, sim)
    if (refusal) {
      this.#settle(action, 'rejected', refusal, `没法${action.verb}(${action.target ?? '*'})`)
      return
    }
    const minutes = DURATION_MIN[action.verb] ?? 10
    this.#running = { action, startAt: sim, endAt: sim + minutes * MINUTE }
    this.#truth('action_started', { actionId: action.actionId, verb: action.verb, target: action.target, minutes })
  }

  #complete(action: WorldActionView, sim: number): void {
    const target = action.target ?? ''
    switch (action.verb) {
      case 'move_to': {
        this.#location = target as Place
        // 换了地点：在场状态按新地点重置，不把"本来就在"的人当作"刚来"
        for (const npc of ['npc_lin', 'npc_zhou']) this.#prevPresence[npc] = this.npcAt(npc, sim) === this.#location
        this.#settle(action, 'succeeded', null, `到了${PLACE_NAMES[target as Place] ?? target}`)
        return
      }
      case 'buy': {
        // 执行期间可能被别人买光
        if (this.#stock <= 0) {
          this.#settle(action, 'failed', 'SOLD_OUT', '轮到我的时候面包已经卖完了')
          return
        }
        this.#stock -= 1
        this.#inventory.bread += 1
        this.#settle(action, 'succeeded', null, '买到一块面包，还是温的')
        return
      }
      case 'eat': {
        this.#inventory.bread = Math.max(0, this.#inventory.bread - 1)
        this.#settle(action, 'succeeded', null, '吃完了一块面包')
        return
      }
      case 'talk_to': {
        if (this.npcAt(target, sim) !== this.#location) {
          this.#settle(action, 'failed', 'LEFT_MIDWAY', '话没说完，对方先走了')
          return
        }
        this.#settle(action, 'succeeded', null, target === 'npc_lin' ? '和林姐聊了聊今天的面包' : '看周老师下完一盘棋，聊了几句旧书')
        return
      }
      case 'browse': {
        if (!this.#stallOpen(hourOfDay(sim))) {
          this.#settle(action, 'failed', 'STALL_CLOSED', '翻到一半，摊主收摊了')
          return
        }
        this.#settle(action, 'succeeded', null, '在旧货摊上翻到几张老招牌的照片')
        return
      }
      case 'repair':
        this.#settle(action, 'succeeded', null, '把书脊又补好了一段')
        return
      case 'rest':
        this.#settle(action, 'succeeded', null, '躺了一会儿')
        return
      default:
        this.#settle(action, 'rejected', 'UNKNOWN_VERB', '世界不认识这个动作')
    }
  }
}

function describeEvents(events: string[]): string {
  const text: Record<string, string> = {
    npc_arrived: '来了',
    npc_left: '走了',
    stall_open: '旧货摊开张了',
    stall_closed: '旧货摊收摊了',
    stock_out: '面包卖完了',
  }
  const names: Record<string, string> = { npc_lin: '林姐', npc_zhou: '周老师' }
  return events
    .map((e) => {
      const [kind, who] = e.split(':')
      const verb = text[kind ?? ''] ?? kind
      return kind === 'npc_arrived' || kind === 'npc_left' ? `${names[who ?? ''] ?? who}${verb}` : verb
    })
    .join('，')
}
