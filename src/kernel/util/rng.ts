/**
 * 可注入的确定性随机源。
 *
 * 角色行为里存在「轻微随机」（措辞选择、生活事件抽取），但测试必须可重放，
 * 因此所有随机都走这个接口，默认实现是 mulberry32。
 */

export interface Rng {
  next(): number
  int(maxExclusive: number): number
  pick<T>(items: readonly T[]): T
}

export class SeededRng implements Rng {
  #state: number

  constructor(seed: number) {
    if (!Number.isInteger(seed)) throw new TypeError('seed 必须是整数')
    this.#state = seed >>> 0
  }

  next(): number {
    // mulberry32
    this.#state = (this.#state + 0x6d2b79f5) >>> 0
    let t = this.#state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  int(maxExclusive: number): number {
    if (maxExclusive <= 0) throw new RangeError('maxExclusive 必须为正数')
    return Math.floor(this.next() * maxExclusive)
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new RangeError('pick() 不能用于空数组')
    return items[this.int(items.length)]!
  }
}
