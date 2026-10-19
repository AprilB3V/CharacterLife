/** 可注入的 id 生成器：测试里用确定性序列，演示里用时间前缀。 */

export interface IdFactory {
  next(prefix: string): string
}

export class SequentialIdFactory implements IdFactory {
  #counters = new Map<string, number>()

  next(prefix: string): string {
    const n = (this.#counters.get(prefix) ?? 0) + 1
    this.#counters.set(prefix, n)
    return `${prefix}_${String(n).padStart(3, '0')}`
  }
}

export class EntropyIdFactory implements IdFactory {
  next(prefix: string): string {
    const rand = Math.random().toString(36).slice(2, 8)
    return `${prefix}_${Date.now().toString(36)}${rand}`
  }
}

export function createId(prefix: string): string {
  return new EntropyIdFactory().next(prefix)
}
