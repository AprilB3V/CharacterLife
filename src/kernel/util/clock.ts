/**
 * 时间抽象。
 *
 * 引擎内部一律使用「模拟时间」`sim`（毫秒，从角色时间线起点算起的虚构时间）。
 * 真实世界时间 `wall` 只用于日志与审计，不参与任何判定，这样测试与演示可以被
 * 完全重放：同一份输入 + 同一个 ManualClock 必然得到同一份输出。
 */

export interface Clock {
  /** 当前模拟时间（毫秒） */
  nowSim(): number
  /** 当前真实时间（用于审计日志） */
  nowWall(): Date
  /**
   * 把模拟时间推进到指定时刻。真实时钟无法被拨动，因此是可选的：
   * 系统时钟下事件会以「真实当前时间」触发，仍然保持单调但不做回拨。
   */
  setSim?(sim: number): void
}

/** 手动时钟：测试与演示使用，时间只在显式 advance 时前进。 */
export class ManualClock implements Clock {
  #sim: number
  #wallBase: Date
  #wallElapsed = 0

  constructor(startSim = 0, wallBase: Date = new Date('2025-01-01T00:00:00.000Z')) {
    this.#sim = startSim
    this.#wallBase = wallBase
  }

  nowSim(): number {
    return this.#sim
  }

  nowWall(): Date {
    return new Date(this.#wallBase.getTime() + this.#wallElapsed)
  }

  /** 推进模拟时间；wall 同步前进，便于日志时间戳保持单调。 */
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`advance() 需要非负毫秒数，收到: ${ms}`)
    }
    this.#sim += ms
    this.#wallElapsed += ms
  }

  setSim(sim: number): void {
    if (sim < this.#sim) {
      throw new RangeError('模拟时间不可倒退（会破坏事件顺序与记忆时间线）')
    }
    this.#wallElapsed += sim - this.#sim
    this.#sim = sim
  }
}

/** 系统时钟：真实运行时使用，模拟时间直接取 Date.now()。 */
export class SystemClock implements Clock {
  nowSim(): number {
    return Date.now()
  }
  nowWall(): Date {
    return new Date()
  }
}

export const HOUR = 60 * 60 * 1000
export const DAY = 24 * HOUR

/** 把毫秒解析成人类可读的「第 X 天 HH:MM」。仅用于演示输出。 */
export function formatSim(sim: number, epoch: Date = new Date('2025-01-01T00:00:00.000Z')): string {
  const d = new Date(epoch.getTime() + sim)
  const day = Math.floor(sim / DAY) + 1
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `Day${day} ${hh}:${mm}`
}
