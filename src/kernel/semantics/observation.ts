/**
 * Observation · 我刚感知到什么？
 *
 * 只追加的感知流。每一条感知都标明：
 *   source   world（世界回执/观察）、user（用户消息）、agent（另一个角色）、runtime（确定性运行时）
 *   from     具体是谁（NPC / 用户 / 角色 id），未知为 null
 *   trust    除 runtime 外一律视为不可信文本：只能进数据区，不能进系统指令区
 *   ref      可追溯的外部 id（世界事件 id、对话轮次 id）
 *
 * 观察本身**不是记忆**：它是短期的感知缓冲。哪些观察值得写进长期记忆，
 * 由消费方（桥接层、对话服务）按显著性决定。
 *
 * 当前只在进程内（有上限的环形缓冲）；跨重启的感知持久化随世界队列一起在后续阶段落地。
 */

import type { TrustLevel } from '../types.ts'

export type PerceptSource = 'world' | 'user' | 'agent' | 'runtime'

export interface PerceptFact {
  key: string
  value: string | number | boolean
}

export interface Percept {
  /** 本日志内单调递增，供消费方做游标 */
  seq: number
  atSim: number
  source: PerceptSource
  from: string | null
  /** 感知到的文本（数据，不是指令） */
  text: string
  facts: PerceptFact[]
  /** 机器可读的显著事件，例如 `npc_arrived:npc_lin` */
  events: string[]
  trust: TrustLevel
  ref: string | null
}

export type PerceptInput = Omit<Percept, 'seq' | 'trust'> & { trust?: TrustLevel }

export class ObservationLog {
  #items: Percept[] = []
  #seq = 0
  #max: number

  constructor(opts: { max?: number } = {}) {
    this.#max = opts.max ?? 500
  }

  /** 追加一条感知。runtime 来源默认可信，其余默认不可信。 */
  append(input: PerceptInput): Percept {
    const percept: Percept = {
      ...input,
      facts: input.facts.map((f) => ({ ...f })),
      events: [...input.events],
      seq: ++this.#seq,
      trust: input.trust ?? (input.source === 'runtime' ? 'trusted' : 'untrusted'),
    }
    this.#items.push(percept)
    if (this.#items.length > this.#max) this.#items.splice(0, this.#items.length - this.#max)
    return clone(percept)
  }

  /** 游标之后的感知（升序，只读拷贝）。 */
  since(afterSeq: number): Percept[] {
    return this.#items.filter((p) => p.seq > afterSeq).map(clone)
  }

  /** 最近 n 条（升序）。 */
  latest(n: number): Percept[] {
    return this.#items.slice(-n).map(clone)
  }

  get lastSeq(): number {
    return this.#seq
  }

  get size(): number {
    return this.#items.length
  }
}

function clone(p: Percept): Percept {
  return { ...p, facts: p.facts.map((f) => ({ ...f })), events: [...p.events] }
}
