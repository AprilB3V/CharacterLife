/**
 * K4 可复现：登记过的种子流。
 *
 * 规则层面的随机性只能来自账本开头登记过的种子流。种子可以公开 ——
 * 任何人拿到同一个种子与流名，都能重算出同一串随机数，验证"规则没有被暗中调整"。
 *
 * 字符串种子的算法与《罐中斗》第一期引擎（src/rng.ts）**逐位一致**：
 * FNV-1a 把 `种子:流名` 哈希成 32 位，再用 mulberry32 生成序列。
 * 迁移到内核之后，同一个种子跑出来的局与原引擎完全相同。
 *
 * 种子流**不能**用于推导承诺用的 salt（见 K5，salt 只来自密码学随机数）。
 */

import type { Rng } from '../util/rng.ts'

function fnv1a(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** 由字符串种子驱动的确定性随机源（实现内核的 Rng 接口）。 */
export class StreamRng implements Rng {
  #state: number

  constructor(seed: string) {
    this.#state = fnv1a(seed) || 1
  }

  /** [0, 1) */
  next(): number {
    let t = (this.#state = (this.#state + 0x6d2b79f5) >>> 0)
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

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items]
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1)
      const a = out[i] as T
      out[i] = out[j] as T
      out[j] = a
    }
    return out
  }

  chance(p: number): boolean {
    return this.next() < p
  }
}

/** 流的完整种子串：`<局种子>:<流名>`（与原引擎的 `${seed}:order` 约定一致）。 */
export function streamSeed(seed: string, stream: string): string {
  return `${seed}:${stream}`
}
