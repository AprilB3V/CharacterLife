/**
 * SQLite 持久层：模板、实例、会话、记忆、事件、快照、冲突、上下文用量。
 *
 * 这一层是「记忆区」的可靠底层，替代 V0.1 早期的单个 JSON 文件。
 * 所有方法都要求显式传 `instanceId`，SQL 里也强制带该条件 —— 实例隔离是
 * 结构性的，不依赖调用方自觉。
 */

import type { CharacterDatabase } from './database.ts'
import type {
  CharacterDynamicState,
  CharacterProfile,
  CharacterVoice,
  MemoryEntry,
  RelationshipState,
  TimelineEvent,
} from '../types.ts'
import type { CharacterInstance, SessionEndReason, SessionRecord } from '../character/instance.ts'
import {
  createInstanceRecord,
  createSessionRecord,
} from '../character/instance.ts'
import type { CreateInstanceInput } from '../character/instance.ts'
import type { CharacterTemplate } from '../character/template.ts'
import { defineTemplate, stableStringify } from '../character/template.ts'
import type { Actor } from '../kernel/policy/policy.ts'
import type { ConflictCandidate, ConflictKind, ConflictResolution, StoredConflict } from '../kernel/memory/conflicts.ts'
import { detectConflicts } from '../kernel/memory/conflicts.ts'
import { rankMemories } from '../kernel/memory/ranking.ts'
import type { RankedMemory } from '../kernel/memory/ranking.ts'
import type { TemplateEventSpec } from '../character/template.ts'
import { SCHEMA_VERSION } from './schema.ts'

/* ==========================================================================
 * 事件（append-only）
 * ========================================================================== */

export type PersistedEventType =
  | 'state_patch'
  | 'milestone'
  | 'memory_written'
  | 'memory_write_rejected'
  | 'memory_deleted'
  | 'memory_superseded'
  | 'turn'
  | 'event_fired'
  | 'session_started'
  | 'session_ended'
  | 'template_migrated'
  | 'conflict_detected'
  | 'context_degraded'
  | 'profile_write_attempt'

export interface PersistedEvent {
  seq: number
  instanceId: string
  sessionId: string | null
  type: PersistedEventType
  atSim: number
  atWall: string
  actor: string
  summary: string
  data: Record<string, unknown>
}

/** 可重放的状态补丁事件：`data.proposals` 是按顺序应用的状态变更。 */
export interface StatePatchData {
  proposals: Array<{
    target: string
    op: string
    path: string
    value: unknown
    reason: string
    evidence: string[]
  }>
  source: string
}

/* ==========================================================================
 * 持久化状态
 * ========================================================================== */

export interface PersistedState {
  schemaVersion: number
  relationship: RelationshipState
  dynamic: CharacterDynamicState
  timeline: TimelineEvent[]
  /** 工作区的 runtime section（待发送消息、约定、限速时间戳等） */
  runtime: unknown
  lastEventSeq: number
  savedAtSim: number
  savedAtWall: string
}

export interface SnapshotRecord {
  id: number
  instanceId: string
  schemaVersion: number
  savedAtSim: number
  savedAtWall: string
  lastEventSeq: number
  state: PersistedState
}

export interface ContextUsageRecord {
  id: string
  instanceId: string
  sessionId: string | null
  turnId: string
  provider: string
  model: string
  budget: number
  estPromptTokens: number
  actualPromptTokens: number | null
  actualCompletionTokens: number | null
  degradation: string
  droppedHistoryTurns: number
  droppedMemoryIds: string[]
  digestedTurns: number
  createdAtSim: number
}

export class MemoryWriteRejected extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(`记忆写入被持久层拒绝：${reason}`)
    this.name = 'MemoryWriteRejected'
    this.reason = reason
  }
}

/* ==========================================================================
 * 行映射
 * ========================================================================== */

interface MemoryRow {
  id: string
  instance_id: string
  kind: string
  title: string
  content: string
  status: string
  origin: string
  trust: string
  confirmed: number
  salience: number
  tags_json: string
  created_sim: number
  created_wall: string
  source_ref: string | null
  deleted_at_sim: number | null
}

function rowToMemory(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    kind: row.kind as MemoryEntry['kind'],
    title: row.title,
    content: row.content,
    status: row.status as MemoryEntry['status'],
    origin: row.origin as MemoryEntry['origin'],
    trust: row.trust as MemoryEntry['trust'],
    confirmed: row.confirmed === 1,
    salience: row.salience,
    tags: JSON.parse(row.tags_json) as string[],
    createdAtSim: row.created_sim,
    createdAtWall: row.created_wall,
    sourceRef: row.source_ref,
    deletedAtSim: row.deleted_at_sim,
  }
}

interface InstanceRow {
  id: string
  template_id: string
  template_version: number
  template_hash: string
  player_id: string
  world_id: string
  label: string
  created_at: string
  last_active_at: string
}

function rowToInstance(row: InstanceRow): CharacterInstance {
  return {
    id: row.id,
    templateId: row.template_id,
    templateVersion: row.template_version,
    templateHash: row.template_hash,
    playerId: row.player_id,
    worldId: row.world_id,
    label: row.label,
    createdAtWall: row.created_at,
    lastActiveAtWall: row.last_active_at,
  }
}

/* ==========================================================================
 * CharacterPersistence
 * ========================================================================== */

export class CharacterPersistence {
  readonly #db: CharacterDatabase

  constructor(db: CharacterDatabase) {
    this.#db = db
  }

  get database(): CharacterDatabase {
    return this.#db
  }

  close(): void {
    this.#db.close()
  }

  /* ------------------------------------------------------------- templates */

  putTemplate(template: CharacterTemplate): void {
    this.#db
      .prepare(
        `INSERT INTO templates (id, version, content_hash, profile_json, voice_json, timeline_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id, version) DO UPDATE SET
           content_hash = excluded.content_hash,
           profile_json = excluded.profile_json,
           voice_json = excluded.voice_json,
           timeline_json = excluded.timeline_json`,
      )
      .run(
        template.id,
        template.version,
        template.contentHash,
        JSON.stringify(template.profile),
        JSON.stringify(template.voice),
        JSON.stringify(template.timeline),
        template.createdAtWall,
      )
  }

  getTemplate(id: string, version: number): CharacterTemplate | null {
    const row = this.#db
      .prepare('SELECT * FROM templates WHERE id = ? AND version = ?')
      .get(id, version) as
      | {
          id: string
          version: number
          content_hash: string
          profile_json: string
          voice_json: string
          timeline_json: string
          created_at: string
        }
      | undefined
    if (!row) return null
    return defineTemplate({
      id: row.id,
      version: row.version,
      profile: JSON.parse(row.profile_json) as CharacterProfile,
      voice: JSON.parse(row.voice_json) as CharacterVoice,
      timeline: JSON.parse(row.timeline_json) as TemplateEventSpec[],
      createdAtWall: row.created_at,
    })
  }

  latestTemplateVersion(id: string): number | null {
    const row = this.#db.prepare('SELECT MAX(version) AS v FROM templates WHERE id = ?').get(id) as
      | { v: number | null }
      | undefined
    return row?.v ?? null
  }

  listTemplates(id: string): Array<{ version: number; contentHash: string; createdAtWall: string }> {
    const rows = this.#db
      .prepare('SELECT version, content_hash, created_at FROM templates WHERE id = ? ORDER BY version')
      .all(id) as Array<{ version: number; content_hash: string; created_at: string }>
    return rows.map((r) => ({ version: r.version, contentHash: r.content_hash, createdAtWall: r.created_at }))
  }

  /* ------------------------------------------------------------- instances */

  createInstance(input: CreateInstanceInput, id: string, nowIso: string): CharacterInstance {
    const existing = this.getInstance(input.id ?? id)
    if (existing && input.id) return existing
    const record = createInstanceRecord(input, id, nowIso)
    this.#db
      .prepare(
        `INSERT INTO instances (id, template_id, template_version, template_hash, player_id, world_id, label, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.templateId,
        record.templateVersion,
        record.templateHash,
        record.playerId,
        record.worldId,
        record.label,
        record.createdAtWall,
        record.lastActiveAtWall,
      )
    return record
  }

  getInstance(id: string): CharacterInstance | null {
    const row = this.#db.prepare('SELECT * FROM instances WHERE id = ?').get(id) as InstanceRow | undefined
    return row ? rowToInstance(row) : null
  }

  requireInstance(id: string): CharacterInstance {
    const instance = this.getInstance(id)
    if (!instance) throw new Error(`实例不存在：${id}`)
    return instance
  }

  listInstances(filter: { playerId?: string; worldId?: string } = {}): CharacterInstance[] {
    const clauses: string[] = []
    const params: string[] = []
    if (filter.playerId) {
      clauses.push('player_id = ?')
      params.push(filter.playerId)
    }
    if (filter.worldId) {
      clauses.push('world_id = ?')
      params.push(filter.worldId)
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''
    const rows = this.#db
      .prepare(`SELECT * FROM instances ${where} ORDER BY created_at`)
      .all(...params) as unknown as InstanceRow[]
    return rows.map(rowToInstance)
  }

  touchInstance(id: string, nowIso: string): void {
    this.#db.prepare('UPDATE instances SET last_active_at = ? WHERE id = ?').run(nowIso, id)
  }

  /**
   * 模板版本迁移：唯一允许改变实例所绑人格的路径。
   * 必须有 `profile:write` 能力，且会留下 `template_migrated` 事件。
   */
  migrateTemplate(opts: {
    instanceId: string
    template: CharacterTemplate
    actor: Actor
    nowSim: number
    nowIso: string
  }): { from: { version: number; hash: string }; to: { version: number; hash: string } } {
    if (!opts.actor.capabilities.has('profile:write')) {
      this.appendEvent({
        instanceId: opts.instanceId,
        sessionId: null,
        type: 'profile_write_attempt',
        atSim: opts.nowSim,
        atWall: opts.nowIso,
        actor: opts.actor.id,
        summary: '缺少 profile:write，拒绝模板迁移',
        data: { templateId: opts.template.id, version: opts.template.version },
      })
      throw new Error(`${opts.actor.id} 缺少 profile:write，拒绝模板迁移`)
    }
    const instance = this.requireInstance(opts.instanceId)
    if (instance.templateId !== opts.template.id) {
      throw new Error(`模板迁移只能在同一角色内进行：${instance.templateId} != ${opts.template.id}`)
    }
    this.putTemplate(opts.template)
    this.#db
      .prepare('UPDATE instances SET template_version = ?, template_hash = ?, last_active_at = ? WHERE id = ?')
      .run(opts.template.version, opts.template.contentHash, opts.nowIso, opts.instanceId)
    this.appendEvent({
      instanceId: opts.instanceId,
      sessionId: null,
      type: 'template_migrated',
      atSim: opts.nowSim,
      atWall: opts.nowIso,
      actor: opts.actor.id,
      summary: `模板版本迁移 ${instance.templateVersion} -> ${opts.template.version}`,
      data: {
        from: { version: instance.templateVersion, hash: instance.templateHash },
        to: { version: opts.template.version, hash: opts.template.contentHash },
      },
    })
    return {
      from: { version: instance.templateVersion, hash: instance.templateHash },
      to: { version: opts.template.version, hash: opts.template.contentHash },
    }
  }

  /* -------------------------------------------------------------- sessions */

  openSession(instanceId: string, id: string, nowIso: string): SessionRecord {
    this.requireInstance(instanceId)
    const session = createSessionRecord(id, instanceId, nowIso)
    this.#db
      .prepare('INSERT INTO sessions (id, instance_id, started_at, ended_at, turn_count, end_reason, summary) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(session.id, session.instanceId, session.startedAtWall, null, 0, null, null)
    this.appendEvent({
      instanceId,
      sessionId: session.id,
      type: 'session_started',
      atSim: 0,
      atWall: nowIso,
      actor: 'system',
      summary: '新会话开始',
      data: { sessionId: session.id },
    })
    return session
  }

  closeSession(
    sessionId: string,
    opts: { turnCount: number; endReason: SessionEndReason; summary?: string | null },
  ): void {
    const row = this.#db
      .prepare('SELECT instance_id, started_at FROM sessions WHERE id = ?')
      .get(sessionId) as { instance_id: string; started_at: string } | undefined
    if (!row) throw new Error(`会话不存在：${sessionId}`)
    this.#db
      .prepare('UPDATE sessions SET ended_at = ?, turn_count = ?, end_reason = ?, summary = ? WHERE id = ?')
      .run(new Date().toISOString(), opts.turnCount, opts.endReason, opts.summary ?? null, sessionId)
    this.appendEvent({
      instanceId: row.instance_id,
      sessionId,
      type: 'session_ended',
      atSim: 0,
      atWall: new Date().toISOString(),
      actor: 'system',
      summary: `会话结束（${opts.endReason}），共 ${opts.turnCount} 轮`,
      data: { turnCount: opts.turnCount, endReason: opts.endReason },
    })
  }

  countTurns(sessionId: string): void {
    this.#db.prepare('UPDATE sessions SET turn_count = turn_count + 1 WHERE id = ?').run(sessionId)
  }

  listSessions(instanceId: string): SessionRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM sessions WHERE instance_id = ? ORDER BY started_at')
      .all(instanceId) as Array<{
      id: string
      instance_id: string
      started_at: string
      ended_at: string | null
      turn_count: number
      end_reason: string | null
      summary: string | null
    }>
    return rows.map((r) => ({
      id: r.id,
      instanceId: r.instance_id,
      startedAtWall: r.started_at,
      endedAtWall: r.ended_at,
      turnCount: r.turn_count,
      endReason: r.end_reason as SessionEndReason | null,
      summary: r.summary,
    }))
  }

  /* ----------------------------------------------------------------- state */

  saveState(
    instanceId: string,
    state: Omit<PersistedState, 'schemaVersion' | 'savedAtSim' | 'savedAtWall'> & {
      savedAtSim: number
      savedAtWall: string
    },
  ): void {
    this.requireInstance(instanceId)
    this.#db
      .prepare(
        `INSERT INTO instance_state (instance_id, schema_version, relationship_json, dynamic_json, timeline_json, runtime_json, last_event_seq, saved_at_sim, saved_at_wall)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(instance_id) DO UPDATE SET
           schema_version = excluded.schema_version,
           relationship_json = excluded.relationship_json,
           dynamic_json = excluded.dynamic_json,
           timeline_json = excluded.timeline_json,
           runtime_json = excluded.runtime_json,
           last_event_seq = excluded.last_event_seq,
           saved_at_sim = excluded.saved_at_sim,
           saved_at_wall = excluded.saved_at_wall`,
      )
      .run(
        instanceId,
        SCHEMA_VERSION,
        JSON.stringify(state.relationship),
        JSON.stringify(state.dynamic),
        JSON.stringify(state.timeline),
        JSON.stringify(state.runtime ?? {}),
        state.lastEventSeq,
        state.savedAtSim,
        state.savedAtWall,
      )
  }

  loadState(instanceId: string): PersistedState | null {
    const row = this.#db.prepare('SELECT * FROM instance_state WHERE instance_id = ?').get(instanceId) as
      | {
          instance_id: string
          schema_version: number
          relationship_json: string
          dynamic_json: string
          timeline_json: string
          runtime_json: string
          last_event_seq: number
          saved_at_sim: number
          saved_at_wall: string
        }
      | undefined
    if (!row) return null
    return {
      schemaVersion: row.schema_version,
      relationship: JSON.parse(row.relationship_json) as RelationshipState,
      dynamic: JSON.parse(row.dynamic_json) as CharacterDynamicState,
      timeline: JSON.parse(row.timeline_json) as TimelineEvent[],
      runtime: JSON.parse(row.runtime_json) as unknown,
      lastEventSeq: row.last_event_seq,
      savedAtSim: row.saved_at_sim,
      savedAtWall: row.saved_at_wall,
    }
  }

  saveSnapshot(instanceId: string, state: PersistedState): SnapshotRecord {
    this.requireInstance(instanceId)
    const info = this.#db
      .prepare(
        `INSERT INTO snapshots (instance_id, schema_version, saved_at_sim, saved_at_wall, last_event_seq, payload_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        instanceId,
        state.schemaVersion,
        state.savedAtSim,
        state.savedAtWall,
        state.lastEventSeq,
        JSON.stringify(state),
      )
    return {
      id: Number(info.lastInsertRowid),
      instanceId,
      schemaVersion: state.schemaVersion,
      savedAtSim: state.savedAtSim,
      savedAtWall: state.savedAtWall,
      lastEventSeq: state.lastEventSeq,
      state,
    }
  }

  latestSnapshot(instanceId: string): SnapshotRecord | null {
    const row = this.#db
      .prepare('SELECT * FROM snapshots WHERE instance_id = ? ORDER BY id DESC LIMIT 1')
      .get(instanceId) as
      | {
          id: number
          instance_id: string
          schema_version: number
          saved_at_sim: number
          saved_at_wall: string
          last_event_seq: number
          payload_json: string
        }
      | undefined
    if (!row) return null
    const state = JSON.parse(row.payload_json) as PersistedState
    return {
      id: row.id,
      instanceId: row.instance_id,
      schemaVersion: row.schema_version,
      savedAtSim: row.saved_at_sim,
      savedAtWall: row.saved_at_wall,
      lastEventSeq: row.last_event_seq,
      state,
    }
  }

  /* ----------------------------------------------------------------- events */

  appendEvent(evt: Omit<PersistedEvent, 'seq'>): PersistedEvent {
    const info = this.#db
      .prepare(
        `INSERT INTO events (instance_id, session_id, type, at_sim, at_wall, actor, summary, data_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        evt.instanceId,
        evt.sessionId,
        evt.type,
        evt.atSim,
        evt.atWall,
        evt.actor,
        evt.summary,
        JSON.stringify(evt.data),
      )
    return { ...evt, seq: Number(info.lastInsertRowid) }
  }

  listEvents(
    instanceId: string,
    opts: { afterSeq?: number; limit?: number; types?: PersistedEventType[] } = {},
  ): PersistedEvent[] {
    const params: Array<string | number> = [instanceId]
    let sql = 'SELECT * FROM events WHERE instance_id = ?'
    if (opts.afterSeq !== undefined) {
      sql += ' AND seq > ?'
      params.push(opts.afterSeq)
    }
    if (opts.types && opts.types.length > 0) {
      sql += ` AND type IN (${opts.types.map(() => '?').join(',')})`
      params.push(...opts.types)
    }
    sql += ' ORDER BY seq ASC'
    if (opts.limit !== undefined) {
      sql += ' LIMIT ?'
      params.push(opts.limit)
    }
    const rows = this.#db.prepare(sql).all(...params) as Array<{
      seq: number
      instance_id: string
      session_id: string | null
      type: string
      at_sim: number
      at_wall: string
      actor: string
      summary: string
      data_json: string
    }>
    return rows.map((r) => ({
      seq: r.seq,
      instanceId: r.instance_id,
      sessionId: r.session_id,
      type: r.type as PersistedEventType,
      atSim: r.at_sim,
      atWall: r.at_wall,
      actor: r.actor,
      summary: r.summary,
      data: JSON.parse(r.data_json) as Record<string, unknown>,
    }))
  }

  lastEventSeq(instanceId: string): number {
    const row = this.#db
      .prepare('SELECT MAX(seq) AS seq FROM events WHERE instance_id = ?')
      .get(instanceId) as { seq: number | null } | undefined
    return row?.seq ?? 0
  }

  /* --------------------------------------------------------------- memories */

  /**
   * 写入记忆行。持久层自己也做一道校验（不依赖上层）：
   * - 长度、枚举、`untrusted ⇒ speculation` 的结构性约束；
   * - 跨实例写入一律拒绝。
   */
  insertMemory(instanceId: string, entry: MemoryEntry): void {
    this.requireInstance(instanceId)
    if (entry.content.length === 0) throw new MemoryWriteRejected('内容为空')
    if (entry.content.length > 4000) throw new MemoryWriteRejected('内容超过 4000 字符')
    if (entry.kind !== 'episodic' && entry.kind !== 'user') {
      throw new MemoryWriteRejected(`非法记忆类型：${entry.kind}`)
    }
    if (entry.trust === 'untrusted' && entry.status !== 'speculation') {
      throw new MemoryWriteRejected('不可信来源的记忆必须是 speculation 状态')
    }
    if (entry.confirmed && entry.kind !== 'user') {
      throw new MemoryWriteRejected('只有 user 类型记忆可以有 confirmed 标记')
    }
    this.#db
      .prepare(
        `INSERT INTO memories (id, instance_id, kind, title, content, status, origin, trust, confirmed, salience, tags_json, created_sim, created_wall, source_ref, deleted_at_sim)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(instance_id, id) DO UPDATE SET
           title = excluded.title,
           content = excluded.content,
           status = excluded.status,
           salience = excluded.salience,
           tags_json = excluded.tags_json,
           deleted_at_sim = excluded.deleted_at_sim`,
      )
      .run(
        entry.id,
        instanceId,
        entry.kind,
        entry.title,
        entry.content,
        entry.status,
        entry.origin,
        entry.trust,
        entry.confirmed ? 1 : 0,
        entry.salience,
        JSON.stringify(entry.tags),
        entry.createdAtSim,
        entry.createdAtWall,
        entry.sourceRef,
        entry.deletedAtSim,
      )
    this.appendEvent({
      instanceId,
      sessionId: null,
      type: 'memory_written',
      atSim: entry.createdAtSim,
      atWall: entry.createdAtWall,
      actor: 'memory',
      summary: `写入记忆 ${entry.id}（${entry.kind}/${entry.status}/${entry.trust}）`,
      data: { memoryId: entry.id, title: entry.title, tags: entry.tags },
    })
  }

  getMemory(instanceId: string, memoryId: string): MemoryEntry | null {
    const row = this.#db
      .prepare('SELECT * FROM memories WHERE instance_id = ? AND id = ?')
      .get(instanceId, memoryId) as MemoryRow | undefined
    return row ? rowToMemory(row) : null
  }

  listMemories(
    instanceId: string,
    opts: { includeDeleted?: boolean; kinds?: Array<'episodic' | 'user'> } = {},
  ): MemoryEntry[] {
    let sql = 'SELECT * FROM memories WHERE instance_id = ?'
    const params: Array<string | number> = [instanceId]
    if (!opts.includeDeleted) sql += ' AND deleted_at_sim IS NULL'
    if (opts.kinds && opts.kinds.length > 0) {
      sql += ` AND kind IN (${opts.kinds.map(() => '?').join(',')})`
      params.push(...opts.kinds)
    }
    sql += ' ORDER BY created_sim ASC, id ASC'
    const rows = this.#db.prepare(sql).all(...params) as unknown as MemoryRow[]
    return rows.map(rowToMemory)
  }

  softDeleteMemory(instanceId: string, memoryId: string, sim: number): boolean {
    const info = this.#db
      .prepare('UPDATE memories SET deleted_at_sim = ? WHERE instance_id = ? AND id = ? AND deleted_at_sim IS NULL')
      .run(sim, instanceId, memoryId)
    if (Number(info.changes) > 0) {
      this.appendEvent({
        instanceId,
        sessionId: null,
        type: 'memory_deleted',
        atSim: sim,
        atWall: new Date().toISOString(),
        actor: 'memory',
        summary: `软删除记忆 ${memoryId}`,
        data: { memoryId },
      })
      return true
    }
    return false
  }

  /** 长期记忆检索：SQL 取活跃行，再用与内存版一致的打分排序。 */
  searchMemories(
    instanceId: string,
    query: string,
    opts: { nowSim: number; limit?: number; budgetChars?: number },
  ): RankedMemory[] {
    const entries = this.listMemories(instanceId)
    return rankMemories(entries, query, opts)
  }

  /* -------------------------------------------------------------- conflicts */

  detectAndStoreConflicts(instanceId: string, nowSim: number): StoredConflict[] {
    const entries = this.listMemories(instanceId)
    const candidates = detectConflicts(entries, { nowSim })
    const stored: StoredConflict[] = []
    for (const candidate of candidates) {
      const existing = this.#db
        .prepare(
          'SELECT id FROM memory_conflicts WHERE instance_id = ? AND older_id = ? AND newer_id = ? AND kind = ?',
        )
        .get(instanceId, candidate.olderId, candidate.newerId, candidate.kind) as { id: string } | undefined
      if (existing) continue
      const conflict = this.#storeConflict(instanceId, candidate, nowSim)
      stored.push(conflict)
    }
    return stored
  }

  #storeConflict(instanceId: string, candidate: ConflictCandidate, nowSim: number): StoredConflict {
    const id = `cf_${instanceId}_${candidate.olderId}_${candidate.newerId}_${candidate.kind}`.slice(0, 180)
    this.#db
      .prepare(
        `INSERT INTO memory_conflicts (id, instance_id, kind, older_id, newer_id, subject, detail, detected_at_sim, resolution, resolved_at_sim)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unresolved', NULL)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        id,
        instanceId,
        candidate.kind,
        candidate.olderId,
        candidate.newerId,
        candidate.subject,
        candidate.detail,
        nowSim,
      )
    this.appendEvent({
      instanceId,
      sessionId: null,
      type: 'conflict_detected',
      atSim: nowSim,
      atWall: new Date().toISOString(),
      actor: 'memory',
      summary: `检测到记忆冲突（${candidate.kind}）：${candidate.subject}`,
      data: { conflictId: id, ...candidate },
    })
    return {
      id,
      instanceId,
      kind: candidate.kind as ConflictKind,
      olderId: candidate.olderId,
      newerId: candidate.newerId,
      subject: candidate.subject,
      detail: candidate.detail,
      detectedAtSim: nowSim,
      resolution: 'unresolved',
      resolvedAtSim: null,
    }
  }

  listConflicts(instanceId: string, opts: { onlyUnresolved?: boolean } = {}): StoredConflict[] {
    const sql =
      'SELECT * FROM memory_conflicts WHERE instance_id = ?' +
      (opts.onlyUnresolved ? " AND resolution = 'unresolved'" : '') +
      ' ORDER BY detected_at_sim, id'
    const rows = this.#db.prepare(sql).all(instanceId) as Array<{
      id: string
      instance_id: string
      kind: string
      older_id: string
      newer_id: string
      subject: string
      detail: string
      detected_at_sim: number
      resolution: string
      resolved_at_sim: number | null
    }>
    return rows.map((r) => ({
      id: r.id,
      instanceId: r.instance_id,
      kind: r.kind as ConflictKind,
      olderId: r.older_id,
      newerId: r.newer_id,
      subject: r.subject,
      detail: r.detail,
      detectedAtSim: r.detected_at_sim,
      resolution: r.resolution as ConflictResolution,
      resolvedAtSim: r.resolved_at_sim,
    }))
  }

  /**
   * 显式把旧记忆标记为被新记忆取代（软删除旧记忆 + 记录解决方式）。
   * 不做「自动以新覆盖旧」：必须调用方明确决定。
   */
  supersedeMemory(opts: {
    instanceId: string
    conflictId: string
    nowSim: number
    resolution?: ConflictResolution
  }): boolean {
    const conflict = this.listConflicts(opts.instanceId).find((c) => c.id === opts.conflictId)
    if (!conflict) return false
    this.softDeleteMemory(opts.instanceId, conflict.olderId, opts.nowSim)
    const resolution = opts.resolution ?? 'newer_wins'
    this.#db
      .prepare('UPDATE memory_conflicts SET resolution = ?, resolved_at_sim = ? WHERE id = ?')
      .run(resolution, opts.nowSim, opts.conflictId)
    this.appendEvent({
      instanceId: opts.instanceId,
      sessionId: null,
      type: 'memory_superseded',
      atSim: opts.nowSim,
      atWall: new Date().toISOString(),
      actor: 'memory',
      summary: `旧记忆 ${conflict.olderId} 被 ${conflict.newerId} 取代`,
      data: { conflictId: opts.conflictId, resolution },
    })
    return true
  }

  /* -------------------------------------------------------- context usage */

  recordContextRequest(record: ContextUsageRecord): void {
    this.#db
      .prepare(
        `INSERT INTO context_requests (id, instance_id, session_id, turn_id, provider, model, budget, est_prompt_tokens, actual_prompt_tokens, actual_completion_tokens, degradation, dropped_history_turns, dropped_memory_ids, digested_turns, created_at_sim)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.instanceId,
        record.sessionId,
        record.turnId,
        record.provider,
        record.model,
        record.budget,
        record.estPromptTokens,
        record.actualPromptTokens,
        record.actualCompletionTokens,
        record.degradation,
        record.droppedHistoryTurns,
        JSON.stringify(record.droppedMemoryIds),
        record.digestedTurns,
        record.createdAtSim,
      )
    if (record.degradation !== 'none') {
      this.appendEvent({
        instanceId: record.instanceId,
        sessionId: record.sessionId,
        type: 'context_degraded',
        atSim: record.createdAtSim,
        atWall: new Date().toISOString(),
        actor: 'context',
        summary: `上下文降级：${record.degradation}（丢弃 ${record.droppedHistoryTurns} 轮历史 / ${record.droppedMemoryIds.length} 条记忆）`,
        data: {
          turnId: record.turnId,
          degradation: record.degradation,
          droppedHistoryTurns: record.droppedHistoryTurns,
          droppedMemoryIds: record.droppedMemoryIds,
          digestedTurns: record.digestedTurns,
          estPromptTokens: record.estPromptTokens,
          budget: record.budget,
        },
      })
    }
  }

  listContextRequests(instanceId: string, limit = 100): ContextUsageRecord[] {
    const rows = this.#db
      .prepare('SELECT * FROM context_requests WHERE instance_id = ? ORDER BY rowid DESC LIMIT ?')
      .all(instanceId, limit) as Array<{
      id: string
      instance_id: string
      session_id: string | null
      turn_id: string
      provider: string
      model: string
      budget: number
      est_prompt_tokens: number
      actual_prompt_tokens: number | null
      actual_completion_tokens: number | null
      degradation: string
      dropped_history_turns: number
      dropped_memory_ids: string
      digested_turns: number
      created_at_sim: number
    }>
    return rows
      .map((r) => ({
        id: r.id,
        instanceId: r.instance_id,
        sessionId: r.session_id,
        turnId: r.turn_id,
        provider: r.provider,
        model: r.model,
        budget: r.budget,
        estPromptTokens: r.est_prompt_tokens,
        actualPromptTokens: r.actual_prompt_tokens,
        actualCompletionTokens: r.actual_completion_tokens,
        degradation: r.degradation,
        droppedHistoryTurns: r.dropped_history_turns,
        droppedMemoryIds: JSON.parse(r.dropped_memory_ids) as string[],
        digestedTurns: r.digested_turns,
        createdAtSim: r.created_at_sim,
      }))
      .reverse()
  }

  /* ---------------------------------------------------------------- export */

  exportInstance(instanceId: string): {
    instance: CharacterInstance
    state: PersistedState | null
    memories: MemoryEntry[]
    sessions: SessionRecord[]
    conflicts: StoredConflict[]
    events: PersistedEvent[]
    contextRequests: ContextUsageRecord[]
    exportedAtWall: string
  } {
    return {
      instance: this.requireInstance(instanceId),
      state: this.loadState(instanceId),
      memories: this.listMemories(instanceId, { includeDeleted: true }),
      sessions: this.listSessions(instanceId),
      conflicts: this.listConflicts(instanceId),
      events: this.listEvents(instanceId),
      contextRequests: this.listContextRequests(instanceId, 1000),
      exportedAtWall: new Date().toISOString(),
    }
  }

  /** 给测试/演示用的稳定指纹：用于断言「重放得到的状态与快照一致」。 */
  static fingerprint(state: Pick<PersistedState, 'relationship' | 'dynamic' | 'timeline'>): string {
    return stableStringify({
      relationship: state.relationship,
      dynamic: state.dynamic,
      timeline: state.timeline,
    })
  }
}
