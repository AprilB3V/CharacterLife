/**
 * 完整性账本的 SQLite 旁路（宪法 K3）。
 *
 * 账本本身在内核里，不认识 SQLite；这里只把每一次追加与擦除同步到 `ledger` 表。
 */

import type { LedgerRecord, LedgerSink } from '../kernel/integrity/ledger.ts'
import type { CharacterPersistence } from './store.ts'

export class SqliteLedgerSink implements LedgerSink {
  #persistence: CharacterPersistence
  #instanceId: string

  constructor(persistence: CharacterPersistence, instanceId: string) {
    this.#persistence = persistence
    this.#instanceId = instanceId
  }

  onAppend(record: LedgerRecord, content: unknown): void {
    this.#persistence.appendLedger(this.#instanceId, record, content)
  }

  onErase(seq: number): void {
    this.#persistence.eraseLedgerContent(this.#instanceId, seq)
  }
}
