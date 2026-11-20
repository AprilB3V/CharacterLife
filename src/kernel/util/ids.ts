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

  /**
   * 把某个前缀的计数器抬到至少 n。
   * 跨会话恢复时必须调用：否则新会话的 id 会从 001 重新开始，
   * 与数据库里已有的里程碑/记忆 id 撞车。
   */
  seed(prefix: string, n: number): void {
    if (!Number.isFinite(n) || n < 0) return
    this.#counters.set(prefix, Math.max(this.#counters.get(prefix) ?? 0, Math.floor(n)))
  }

  counter(prefix: string): number {
    return this.#counters.get(prefix) ?? 0
  }
}

export class EntropyIdFactory implements IdFactory {
  next(prefix: string): string {
    const rand = Math.random().toString(36).slice(2, 8)
    return `${prefix}_${Date.now().toString(36)}${rand}`
  }
}

/** Id prefixes a restored character workspace may already hold. */
export const RESTORED_ID_PREFIXES = ['mem_ep', 'mem_us', 'ms', 'bnd', 'msg', 'prom', 'evt'] as const

/**
 * Continue numbering above every id already present in a restored state (any JSON-serialisable
 * value). Counting live entries is not enough: settled promises, delivered messages, deleted or
 * evicted memories keep their ids, and list() calls are capped.
 */
export function seedFromState(ids: SequentialIdFactory, state: unknown, prefixes: readonly string[] = RESTORED_ID_PREFIXES): void {
  const text = JSON.stringify(state) ?? ''
  for (const prefix of prefixes) {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    let max = 0
    for (const m of text.matchAll(new RegExp(`"${escaped}_(\\d+)"`, 'g'))) max = Math.max(max, Number(m[1]))
    ids.seed(prefix, max)
  }
}

export function createId(prefix: string): string {
  return new EntropyIdFactory().next(prefix)
}
