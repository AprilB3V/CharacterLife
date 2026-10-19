/**
 * 平台接入层的持久化（V0.2 新增四张表）。
 *
 * 这一层是「平台身份 ↔ 角色实例」的唯一权威：
 * - 引擎不关心消息从哪来，只按 instanceId 工作；
 * - 平台侧永远拿不到数据库句柄，只能通过 API Gateway 间接使用。
 */

import type { CharacterDatabase } from './database.ts'
import type { PlatformBinding } from '../adapters/protocol.ts'

export type BindingSource = 'primary' | 'code' | 'admin'

export interface BindingCodeRecord {
  codeHash: string
  instanceId: string
  targetPlatform: string
  createdAt: string
  expiresAt: string
  attempts: number
  maxAttempts: number
  consumedAt: string | null
  createdBy: string
}

export type RedeemFailure =
  | 'NOT_FOUND'
  | 'EXPIRED'
  | 'CONSUMED'
  | 'TOO_MANY_ATTEMPTS'
  | 'PLATFORM_MISMATCH'

export interface RedeemResult {
  ok: boolean
  instanceId: string | null
  failure: RedeemFailure | null
}

interface BindingRow {
  platform: string
  platform_user_id: string
  instance_id: string
  display_name: string | null
  binding_source: string
  created_at: string
  last_seen_at: string
}

function rowToBinding(row: BindingRow): PlatformBinding {
  return {
    platform: row.platform,
    platformUserId: row.platform_user_id,
    instanceId: row.instance_id,
    displayName: row.display_name,
    source: row.binding_source as BindingSource,
    createdAtWall: row.created_at,
    lastSeenAtWall: row.last_seen_at,
  }
}

export class PlatformStore {
  #db: CharacterDatabase

  constructor(db: CharacterDatabase) {
    this.#db = db
  }

  /* ------------------------------------------------------------- bindings */

  getBinding(platform: string, platformUserId: string): PlatformBinding | null {
    const row = this.#db
      .prepare('SELECT * FROM platform_identities WHERE platform = ? AND platform_user_id = ?')
      .get(platform, platformUserId) as unknown as BindingRow | undefined
    return row ? rowToBinding(row) : null
  }

  listBindings(instanceId: string): PlatformBinding[] {
    const rows = this.#db
      .prepare('SELECT * FROM platform_identities WHERE instance_id = ? ORDER BY created_at')
      .all(instanceId) as unknown as BindingRow[]
    return rows.map(rowToBinding)
  }

  /** 绑定一个平台身份；已存在且指向别的实例时抛错（防止记忆串号）。 */
  bind(opts: {
    platform: string
    platformUserId: string
    instanceId: string
    displayName?: string | null
    source: BindingSource
    nowIso: string
    allowRebind?: boolean
  }): PlatformBinding {
    const existing = this.getBinding(opts.platform, opts.platformUserId)
    if (existing) {
      if (existing.instanceId !== opts.instanceId) {
        if (!opts.allowRebind) {
          throw new Error(
            `平台身份 ${opts.platform}:${opts.platformUserId} 已绑定到实例 ${existing.instanceId}，` +
              '拒绝静默改绑（需要先解绑）',
          )
        }
        this.unbind(opts.platform, opts.platformUserId)
      } else {
        this.touch(opts.platform, opts.platformUserId, opts.nowIso)
        return { ...existing, lastSeenAtWall: opts.nowIso }
      }
    }
    this.#db
      .prepare(
        `INSERT INTO platform_identities
           (platform, platform_user_id, instance_id, display_name, binding_source, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        opts.platform,
        opts.platformUserId,
        opts.instanceId,
        opts.displayName ?? null,
        opts.source,
        opts.nowIso,
        opts.nowIso,
      )
    return {
      platform: opts.platform,
      platformUserId: opts.platformUserId,
      instanceId: opts.instanceId,
      displayName: opts.displayName ?? null,
      source: opts.source,
      createdAtWall: opts.nowIso,
      lastSeenAtWall: opts.nowIso,
    }
  }

  unbind(platform: string, platformUserId: string): boolean {
    const info = this.#db
      .prepare('DELETE FROM platform_identities WHERE platform = ? AND platform_user_id = ?')
      .run(platform, platformUserId)
    this.#db
      .prepare('DELETE FROM platform_sessions WHERE platform = ? AND platform_user_id = ?')
      .run(platform, platformUserId)
    return Number(info.changes) > 0
  }

  touch(platform: string, platformUserId: string, nowIso: string): void {
    this.#db
      .prepare('UPDATE platform_identities SET last_seen_at = ? WHERE platform = ? AND platform_user_id = ?')
      .run(nowIso, platform, platformUserId)
  }

  /* -------------------------------------------------------------- sessions */

  getSessionId(platform: string, platformUserId: string): string | null {
    const row = this.#db
      .prepare('SELECT session_id FROM platform_sessions WHERE platform = ? AND platform_user_id = ?')
      .get(platform, platformUserId) as { session_id: string } | undefined
    return row?.session_id ?? null
  }

  setSessionId(platform: string, platformUserId: string, instanceId: string, sessionId: string, nowIso: string): void {
    this.#db
      .prepare(
        `INSERT INTO platform_sessions (platform, platform_user_id, instance_id, session_id, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(platform, platform_user_id) DO UPDATE SET
           instance_id = excluded.instance_id,
           session_id = excluded.session_id,
           updated_at = excluded.updated_at`,
      )
      .run(platform, platformUserId, instanceId, sessionId, nowIso)
  }

  clearSessionId(platform: string, platformUserId: string): void {
    this.#db
      .prepare('DELETE FROM platform_sessions WHERE platform = ? AND platform_user_id = ?')
      .run(platform, platformUserId)
  }

  /* ---------------------------------------------------------- binding code */

  createBindingCode(opts: {
    codeHash: string
    instanceId: string
    targetPlatform: string
    ttlMs: number
    maxAttempts: number
    createdBy: string
    nowIso: string
  }): BindingCodeRecord {
    const expiresAt = new Date(new Date(opts.nowIso).getTime() + opts.ttlMs).toISOString()
    this.#db
      .prepare(
        `INSERT INTO binding_codes
           (code_hash, instance_id, target_platform, created_at, expires_at, attempts, max_attempts, consumed_at, created_by)
         VALUES (?, ?, ?, ?, ?, 0, ?, NULL, ?)`,
      )
      .run(
        opts.codeHash,
        opts.instanceId,
        opts.targetPlatform,
        opts.nowIso,
        expiresAt,
        opts.maxAttempts,
        opts.createdBy,
      )
    return {
      codeHash: opts.codeHash,
      instanceId: opts.instanceId,
      targetPlatform: opts.targetPlatform,
      createdAt: opts.nowIso,
      expiresAt,
      attempts: 0,
      maxAttempts: opts.maxAttempts,
      consumedAt: null,
      createdBy: opts.createdBy,
    }
  }

  /** 消费一次性绑定码：过期 / 已用 / 次数超限 / 平台不匹配 全部显式失败。 */
  redeemBindingCode(opts: {
    codeHash: string
    platform: string
    maxAttemptsCap?: number
    nowIso: string
  }): RedeemResult {
    const row = this.#db.prepare('SELECT * FROM binding_codes WHERE code_hash = ?').get(opts.codeHash) as
      | {
          code_hash: string
          instance_id: string
          target_platform: string
          created_at: string
          expires_at: string
          attempts: number
          max_attempts: number
          consumed_at: string | null
          created_by: string
        }
      | undefined
    if (!row) return { ok: false, instanceId: null, failure: 'NOT_FOUND' }
    if (row.consumed_at) return { ok: false, instanceId: null, failure: 'CONSUMED' }
    if (Date.parse(row.expires_at) <= Date.parse(opts.nowIso)) {
      return { ok: false, instanceId: null, failure: 'EXPIRED' }
    }
    const cap = opts.maxAttemptsCap ?? row.max_attempts
    if (row.attempts >= Math.min(cap, row.max_attempts)) {
      return { ok: false, instanceId: null, failure: 'TOO_MANY_ATTEMPTS' }
    }
    if (row.target_platform !== opts.platform) {
      this.#db.prepare('UPDATE binding_codes SET attempts = attempts + 1 WHERE code_hash = ?').run(opts.codeHash)
      return { ok: false, instanceId: null, failure: 'PLATFORM_MISMATCH' }
    }
    const info = this.#db
      .prepare(
        'UPDATE binding_codes SET consumed_at = ?, attempts = attempts + 1 WHERE code_hash = ? AND consumed_at IS NULL',
      )
      .run(opts.nowIso, opts.codeHash)
    if (Number(info.changes) === 0) return { ok: false, instanceId: null, failure: 'CONSUMED' }
    return { ok: true, instanceId: row.instance_id, failure: null }
  }

  /* --------------------------------------------------------- quiet 设置 --- */

  setQuiet(platform: string, platformUserId: string, quiet: boolean, nowIso: string): void {
    this.#db
      .prepare(
        `INSERT INTO identity_settings (platform, platform_user_id, quiet, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(platform, platform_user_id) DO UPDATE SET
           quiet = excluded.quiet,
           updated_at = excluded.updated_at`,
      )
      .run(platform, platformUserId, quiet ? 1 : 0, nowIso)
  }

  isQuiet(platform: string, platformUserId: string): boolean {
    const row = this.#db
      .prepare('SELECT quiet FROM identity_settings WHERE platform = ? AND platform_user_id = ?')
      .get(platform, platformUserId) as { quiet: number } | undefined
    return row?.quiet === 1
  }

  /* ----------------------------------------------------- inbound dedupe --- */

  /** 标记消息已处理；返回 false 表示这条消息之前已经处理过（幂等）。 */
  markProcessed(opts: {
    platform: string
    platformMessageId: string
    instanceId: string | null
    status: string
    nowIso: string
  }): boolean {
    const info = this.#db
      .prepare(
        `INSERT INTO processed_messages (platform, platform_message_id, instance_id, status, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(platform, platform_message_id) DO NOTHING`,
      )
      .run(opts.platform, opts.platformMessageId, opts.instanceId, opts.status, opts.nowIso)
    return Number(info.changes) > 0
  }

  isProcessed(platform: string, platformMessageId: string): boolean {
    const row = this.#db
      .prepare('SELECT 1 AS ok FROM processed_messages WHERE platform = ? AND platform_message_id = ?')
      .get(platform, platformMessageId) as { ok: number } | undefined
    return row !== undefined
  }

  updateProcessedStatus(platform: string, platformMessageId: string, status: string): void {
    this.#db
      .prepare('UPDATE processed_messages SET status = ? WHERE platform = ? AND platform_message_id = ?')
      .run(status, platform, platformMessageId)
  }

  /** 清理旧去重记录，避免表无限增长（默认保留 7 天）。 */
  pruneProcessed(olderThanIso: string): number {
    const info = this.#db
      .prepare('DELETE FROM processed_messages WHERE created_at < ?')
      .run(olderThanIso)
    return Number(info.changes)
  }

  countProcessed(): number {
    const row = this.#db.prepare('SELECT COUNT(*) AS c FROM processed_messages').get() as { c: number }
    return row.c
  }
}
