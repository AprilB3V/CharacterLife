/**
 * K3 只增不改：哈希链账本。
 *
 * 每条记录包含前一条记录的哈希；篡改、插入、删除任何一条都会让校验在那一条断开。
 * 链接的是**内容的哈希**，内容本体单独存放：
 *   - 正常情况下 `verify()` 同时核对「内容本体 ↔ contentHash」与「记录 ↔ 链」；
 *   - 用户要求删除时，擦除内容本体并追加一条墓碑记录 —— 链条仍可校验，
 *     删除这一行为本身留痕，被删的内容不再可读。
 *
 * 纯内存实现，零依赖、不做 I/O；持久化通过 LedgerSink 旁路（SQLite 的 `ledger` 表）。
 */

import { ZERO_HASH, canonicalJson, contentHash, sha256Hex } from './canonical.ts'

export interface LedgerRecord {
  /** 从 1 开始连续递增 */
  seq: number
  kind: string
  actor: string
  atSim: number
  /** K1：记录产生时，相关角色的身份指纹（与角色无关的记录为 null） */
  fingerprint: string | null
  contentHash: string
  prevHash: string
  hash: string
}

export interface LedgerEntryInput {
  kind: string
  actor: string
  content: unknown
  fingerprint?: string | null
}

export type LedgerVerification =
  | { ok: true; records: number; erased: number }
  | { ok: false; brokenAt: number; reason: string }

/** 持久化旁路：账本只通知，不依赖存储。 */
export interface LedgerSink {
  onAppend(record: LedgerRecord, content: unknown): void
  onErase(seq: number): void
}

export function recordHash(r: Omit<LedgerRecord, 'hash'>): string {
  return sha256Hex(
    canonicalJson({
      seq: r.seq,
      kind: r.kind,
      actor: r.actor,
      atSim: r.atSim,
      fingerprint: r.fingerprint,
      contentHash: r.contentHash,
      prevHash: r.prevHash,
    }),
  )
}

/**
 * 校验一串记录（可选附带内容本体）。纯函数，供导入、恢复与第三方核对使用。
 *
 * `withheld`：公开版账本里**有意不公开**内容本体的记录（例如模型原始输出，里面有封存心声）。
 * 这些记录只核对链与记录头；内容哈希等到私有版或揭示时再核对。
 */
export function verifyChain(
  records: readonly LedgerRecord[],
  contents?: ReadonlyMap<number, unknown>,
  opts: { withheld?: ReadonlySet<number> } = {},
): LedgerVerification {
  const withheld = opts.withheld ?? new Set<number>()
  let prev = ZERO_HASH
  let erased = 0
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!
    if (r.seq !== i + 1) return { ok: false, brokenAt: i + 1, reason: `序号不连续：期望 ${i + 1}，实际 ${r.seq}` }
    if (r.prevHash !== prev) return { ok: false, brokenAt: r.seq, reason: '前序哈希不匹配（有记录被插入、删除或改动）' }
    if (recordHash(r) !== r.hash) return { ok: false, brokenAt: r.seq, reason: '记录哈希不匹配（记录头被改动）' }
    if (contents) {
      if (contents.has(r.seq)) {
        if (contentHash(contents.get(r.seq)) !== r.contentHash) {
          return { ok: false, brokenAt: r.seq, reason: '内容本体与内容哈希不符（内容被改动）' }
        }
      } else if (!withheld.has(r.seq)) {
        erased += 1
      }
    }
    prev = r.hash
  }
  if (contents) {
    // 被擦除的内容必须有对应的墓碑，否则就是"悄悄删了"
    const tombstoned = new Set<number>()
    for (const r of records) {
      if (r.kind !== 'tombstone') continue
      const c = contents.get(r.seq) as { target?: unknown } | undefined
      if (c && typeof c.target === 'number') tombstoned.add(c.target)
    }
    for (const r of records) {
      if (!contents.has(r.seq) && !tombstoned.has(r.seq) && !withheld.has(r.seq)) {
        return { ok: false, brokenAt: r.seq, reason: '内容本体缺失且没有墓碑记录' }
      }
    }
  }
  return { ok: true, records: records.length, erased }
}

export class Ledger {
  #records: LedgerRecord[] = []
  #contents = new Map<number, unknown>()
  #sink: LedgerSink | null = null
  #clock: { nowSim(): number }

  constructor(opts: { clock: { nowSim(): number }; sink?: LedgerSink | null }) {
    this.#clock = opts.clock
    this.#sink = opts.sink ?? null
  }

  /** 从持久化数据恢复（不触发 sink）。恢复前先校验，断链直接报错。 */
  static restore(
    opts: { clock: { nowSim(): number }; sink?: LedgerSink | null },
    records: readonly LedgerRecord[],
    contents: ReadonlyMap<number, unknown>,
  ): { ledger: Ledger; verification: LedgerVerification } {
    const ledger = new Ledger({ clock: opts.clock })
    const verification = verifyChain(records, contents)
    ledger.#records = records.map((r) => ({ ...r }))
    ledger.#contents = new Map([...contents].map(([k, v]) => [k, structuredClone(v)]))
    ledger.#sink = opts.sink ?? null
    return { ledger, verification }
  }

  setSink(sink: LedgerSink | null): void {
    this.#sink = sink
  }

  get size(): number {
    return this.#records.length
  }

  get head(): LedgerRecord | null {
    const last = this.#records[this.#records.length - 1]
    return last ? { ...last } : null
  }

  append(input: LedgerEntryInput): LedgerRecord {
    const content = structuredClone(input.content)
    const partial = {
      seq: this.#records.length + 1,
      kind: input.kind,
      actor: input.actor,
      atSim: this.#clock.nowSim(),
      fingerprint: input.fingerprint ?? null,
      contentHash: contentHash(content),
      prevHash: this.#records[this.#records.length - 1]?.hash ?? ZERO_HASH,
    }
    const record: LedgerRecord = { ...partial, hash: recordHash(partial) }
    this.#records.push(record)
    this.#contents.set(record.seq, content)
    this.#sink?.onAppend({ ...record }, structuredClone(content))
    return { ...record }
  }

  /**
   * 擦除内容本体（被遗忘的权利），并追加墓碑。
   * 墓碑本身不能被擦除；同一条不能擦两次。
   */
  erase(seq: number, actor: string, reason: string): LedgerRecord | null {
    const target = this.#records[seq - 1]
    if (!target || target.kind === 'tombstone' || !this.#contents.has(seq)) return null
    this.#contents.delete(seq)
    this.#sink?.onErase(seq)
    return this.append({ kind: 'tombstone', actor, content: { target: seq, reason }, fingerprint: target.fingerprint })
  }

  get(seq: number): LedgerRecord | null {
    const r = this.#records[seq - 1]
    return r ? { ...r } : null
  }

  /** 内容本体（被擦除则为 undefined）。 */
  content(seq: number): unknown {
    return this.#contents.has(seq) ? structuredClone(this.#contents.get(seq)) : undefined
  }

  isErased(seq: number): boolean {
    return seq >= 1 && seq <= this.#records.length && !this.#contents.has(seq)
  }

  records(filter: { kind?: string | RegExp; fromSeq?: number } = {}): LedgerRecord[] {
    return this.#records
      .filter((r) => (filter.fromSeq === undefined ? true : r.seq >= filter.fromSeq))
      .filter((r) =>
        filter.kind === undefined ? true : typeof filter.kind === 'string' ? r.kind === filter.kind : filter.kind.test(r.kind),
      )
      .map((r) => ({ ...r }))
  }

  verify(): LedgerVerification {
    return verifyChain(this.#records, this.#contents)
  }

  /**
   * 导出（记录头 + 仍存在的内容本体），供第三方离线核对。
   * `withhold` 选出不公开内容本体的记录（公开版账本用）；被选中的 seq 列在 `withheld` 里，
   * 核对时传给 `verifyChain(..., { withheld })`。
   */
  export(opts: { withhold?: (record: LedgerRecord) => boolean } = {}): {
    records: LedgerRecord[]
    contents: Array<[number, unknown]>
    withheld: number[]
  } {
    const withheld = new Set(opts.withhold ? this.#records.filter((r) => opts.withhold!(r)).map((r) => r.seq) : [])
    return {
      records: this.#records.map((r) => ({ ...r })),
      contents: [...this.#contents].filter(([k]) => !withheld.has(k)).map(([k, v]) => [k, structuredClone(v)]),
      withheld: [...withheld],
    }
  }
}
