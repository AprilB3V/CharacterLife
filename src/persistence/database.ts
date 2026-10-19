/**
 * SQLite 连接与迁移。
 *
 * 只封装三件事：打开/关闭、事务、schema 版本管理。
 * 业务读写都在 `persistence/store.ts`，避免把 SQL 散落到各处。
 */

import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { PLATFORM_SCHEMA_SQL, SCHEMA_SQL, SCHEMA_VERSION, splitStatements } from './schema.ts'

export class CharacterDatabase {
  readonly db: DatabaseSync
  readonly filePath: string
  #inTransaction = false

  constructor(filePath: string) {
    this.filePath = filePath
    if (filePath !== ':memory:') {
      mkdirSync(dirname(filePath), { recursive: true })
    }
    this.db = new DatabaseSync(filePath)
    if (filePath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode = WAL')
    }
    this.db.exec('PRAGMA foreign_keys = ON')
    this.migrate()
  }

  static memory(): CharacterDatabase {
    return new CharacterDatabase(':memory:')
  }

  /** 预编译语句（业务层不直接接触 DatabaseSync，方便以后换驱动）。 */
  prepare(sql: string): StatementSync {
    return this.db.prepare(sql)
  }

  exec(sql: string): void {
    this.db.exec(sql)
  }

  /**
   * 建表 + 迁移。
   *
   * 迁移策略（V0.2）：
   * - 所有建表语句都是 `IF NOT EXISTS`，可重复执行；
   * - 版本低于代码版本 → 执行增量建表（V1→V2 是纯新增表），然后更新 meta；
   * - 版本高于代码版本 → 显式失败（旧代码读新库会丢数据）。
   */
  migrate(): void {
    for (const stmt of splitStatements(SCHEMA_SQL)) {
      this.db.exec(stmt)
    }
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
      | { value: string }
      | undefined
    if (!row) {
      for (const stmt of splitStatements(PLATFORM_SCHEMA_SQL)) this.db.exec(stmt)
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
      return
    }
    const existing = Number(row.value)
    if (existing > SCHEMA_VERSION) {
      throw new Error(
        `数据库 schema_version=${existing} 高于代码支持的 ${SCHEMA_VERSION}；` +
          '请升级代码，不要用旧版本写新库',
      )
    }
    if (existing < SCHEMA_VERSION) {
      // V1 -> V2：新增平台接入层四张表（纯新增，不改旧表，失败可整体回滚）
      this.transaction(() => {
        for (const stmt of splitStatements(PLATFORM_SCHEMA_SQL)) this.db.exec(stmt)
        this.db
          .prepare('UPDATE meta SET value = ? WHERE key = ?')
          .run(String(SCHEMA_VERSION), 'schema_version')
      })
    }
  }

  transaction<T>(fn: () => T): T {
    if (this.#inTransaction) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    this.#inTransaction = true
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    } finally {
      this.#inTransaction = false
    }
  }

  close(): void {
    this.db.close()
  }

  get schemaVersion(): number {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
      | { value: string }
      | undefined
    return row ? Number(row.value) : 0
  }
}
