/**
 * Memory · 记忆区
 *
 * 四类记忆各归其位：
 * 1. Immutable Character Profile —— 只读对象，**没有任何写入 API**（结构性保证，
 *    而不是靠运行时检查）；聊天层即使被说服也无法调用到修改途径。
 * 2. Episodic Memory —— 共同经历、约定、事件。
 * 3. User Memory —— 用户的偏好；区分「用户确认」与「角色推测」。
 * 4. Dynamic State —— 可变的角色状态与关系状态（由 Runtime 计算，Memory 负责存取）。
 *
 * 每条记忆都带来源（origin + sourceRef）、真实写入时间、模拟时间与认识论状态
 * （事实 / 推测 / 虚构剧情），这样「角色记错事」可以被审计定位，而不是玄学。
 */

import type {
  CharacterDynamicState,
  CharacterProfile,
  EpistemicStatus,
  MemoryEntry,
  MemoryKind,
  MemoryOrigin,
  MemoryQuery,
  RelationshipState,
  TrustLevel,
} from '../types.ts'
import type { Clock } from '../util/clock.ts'
import type { IdFactory } from '../util/ids.ts'
import { detectInjectionMarkers, lexicalOverlap, sanitizeForMemory, tokenize } from '../util/text.ts'
import type { SnapshotSection } from '../storage/snapshot.ts'

export const MEMORY_SCHEMA_VERSION = 1

/** 记忆容量上限：超过后按「低价值优先淘汰」清理，防止无限增长。 */
const MAX_ENTRIES = 400

export interface MemoryWriteInput {
  kind: MemoryKind
  title: string
  content: string
  status: EpistemicStatus
  origin: MemoryOrigin
  trust?: TrustLevel
  /** user 记忆专用：是否由用户明确确认 */
  confirmed?: boolean
  salience?: number
  tags?: string[]
  sourceRef?: string | null
}

export interface RetrievedMemory {
  entry: MemoryEntry
  score: number
  /** 分数构成，便于调试与测试断言 */
  parts: { lexical: number; salience: number; recency: number; status: number; confirmed: number }
}

export interface MemoryExport {
  schemaVersion: number
  exportedAtWall: string
  exportedAtSim: number
  profile: CharacterProfile
  episodic: MemoryEntry[]
  user: MemoryEntry[]
  dynamicState: CharacterDynamicState
  relationship: RelationshipState
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

function statusWeight(status: EpistemicStatus): number {
  // 事实优先于推测；虚构剧情仍然可检索（它构成共同经历），但权重略低。
  switch (status) {
    case 'fact':
      return 1
    case 'fiction':
      return 0.75
    case 'speculation':
      return 0.4
  }
}

export class MemoryStore implements SnapshotSection {
  readonly sectionName = 'memory'
  #profile: CharacterProfile
  #episodic: MemoryEntry[] = []
  #user: MemoryEntry[] = []
  #dynamic: CharacterDynamicState
  #relationship: RelationshipState
  #clock: Clock
  #ids: IdFactory
  /** 每次写入记忆时留下审计痕迹（不持久化在 section 内，由 Runtime 的日志负责持久化） */
  #lastInjectionFlags: string[] = []

  constructor(opts: {
    profile: CharacterProfile
    clock: Clock
    ids: IdFactory
    initialDynamicState: CharacterDynamicState
    initialRelationship: RelationshipState
    snapshot?: {
      episodic?: MemoryEntry[]
      user?: MemoryEntry[]
      dynamicState?: CharacterDynamicState
      relationship?: RelationshipState
    }
  }) {
    this.#profile = deepFreeze(structuredClone(opts.profile))
    this.#clock = opts.clock
    this.#ids = opts.ids
    this.#episodic = opts.snapshot?.episodic?.map(cloneEntry) ?? []
    this.#user = opts.snapshot?.user?.map(cloneEntry) ?? []
    this.#dynamic = structuredClone(opts.snapshot?.dynamicState ?? opts.initialDynamicState)
    this.#relationship = structuredClone(opts.snapshot?.relationship ?? opts.initialRelationship)
  }

  /* ---------------------------------------------------------------- profile */

  /** 只读视图。刻意不提供 setProfile / updateTraits 之类的 API。 */
  getProfile(): Readonly<CharacterProfile> {
    return this.#profile
  }

  /**
   * 仅供显式管理操作（数据所有者，profile:write）使用。
   * V0.1 中不存在任何从对话内容到达这里的调用路径 —— 这是结构性保证。
   */
  replaceProfileForAdmin(profile: CharacterProfile): void {
    this.#profile = deepFreeze(structuredClone(profile))
  }

  /* --------------------------------------------------------------- memories */

  add(input: MemoryWriteInput): MemoryEntry {
    const now = this.#clock.nowSim()
    const rawContent = input.content
    const markers = detectInjectionMarkers(rawContent)
    if (markers.length > 0) {
      this.#lastInjectionFlags = markers
    }
    // 不可信内容永远保持 untrusted：不会因为「看起来像事实」而被升级成指令。
    const trust: TrustLevel =
      input.trust ?? (markers.length > 0 ? 'untrusted' : 'trusted')

    const entry: MemoryEntry = {
      id: this.#ids.next(input.kind === 'episodic' ? 'mem_ep' : 'mem_us'),
      kind: input.kind,
      title: sanitizeForMemory(input.title, 80),
      content: sanitizeForMemory(rawContent),
      status: input.status,
      origin: input.origin,
      trust,
      confirmed: input.kind === 'user' ? (input.confirmed ?? false) : true,
      salience: clamp01(input.salience ?? 0.5),
      tags: (input.tags ?? []).slice(0, 12),
      createdAtSim: now,
      createdAtWall: this.#clock.nowWall().toISOString(),
      sourceRef: input.sourceRef ?? null,
      deletedAtSim: null,
    }

    const bucket = entry.kind === 'episodic' ? this.#episodic : this.#user
    bucket.push(entry)
    this.#enforceCapacity()
    return cloneEntry(entry)
  }

  /** 最近一次写入检测到的注入标记（供 Runtime 记录审计事件）。 */
  takeInjectionFlags(): string[] {
    const f = this.#lastInjectionFlags
    this.#lastInjectionFlags = []
    return f
  }

  get(id: string): MemoryEntry | null {
    const found = [...this.#episodic, ...this.#user].find((e) => e.id === id)
    return found ? cloneEntry(found) : null
  }

  list(query: MemoryQuery = {}): MemoryEntry[] {
    const all = [...this.#episodic, ...this.#user]
    return all
      .filter((e) => (query.includeDeleted ? true : e.deletedAtSim === null))
      .filter((e) => (query.kinds ? query.kinds.includes(e.kind) : true))
      .filter((e) => (query.status ? query.status.includes(e.status) : true))
      .filter((e) => (query.tags && query.tags.length > 0 ? query.tags.some((t) => e.tags.includes(t)) : true))
      .filter((e) => {
        if (!query.text) return true
        const q = tokenize(query.text)
        return lexicalOverlap(q, tokenize(`${e.title} ${e.content} ${e.tags.join(' ')}`)) > 0
      })
      .sort((a, b) => b.createdAtSim - a.createdAtSim || a.id.localeCompare(b.id))
      .slice(0, query.limit ?? 100)
      .map(cloneEntry)
  }

  /**
   * 检索：确定性打分，没有向量库。
   * 分数 = 0.45 * 词面重合 + 0.25 * 显著度 + 0.20 * 时间衰减 + 0.10 * 认识论状态
   *      (+ 0.05 用户已确认 / - 0.10 不可信来源)
   */
  search(
    query: string,
    opts: { nowSim?: number; limit?: number; budgetChars?: number; halfLifeMs?: number } = {},
  ): RetrievedMemory[] {
    const now = opts.nowSim ?? this.#clock.nowSim()
    const halfLife = opts.halfLifeMs ?? 2 * 24 * 60 * 60 * 1000
    const limit = opts.limit ?? 6
    const budget = opts.budgetChars ?? 1200
    const qTokens = tokenize(query)

    const scored: RetrievedMemory[] = []
    for (const entry of [...this.#episodic, ...this.#user]) {
      if (entry.deletedAtSim !== null) continue
      const docTokens = tokenize(`${entry.title} ${entry.content} ${entry.tags.join(' ')}`)
      const lexical = qTokens.length === 0 ? 0 : lexicalOverlap(qTokens, docTokens)
      const age = Math.max(0, now - entry.createdAtSim)
      const recency = Math.pow(0.5, age / halfLife)
      const status = statusWeight(entry.status)
      const confirmed = entry.confirmed ? 1 : 0
      let score =
        0.45 * lexical + 0.25 * entry.salience + 0.2 * recency + 0.1 * status + 0.05 * confirmed
      if (entry.trust === 'untrusted') score -= 0.1
      scored.push({
        entry,
        score,
        parts: { lexical, salience: entry.salience, recency, status, confirmed },
      })
    }

    scored.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))

    const out: RetrievedMemory[] = []
    let used = 0
    for (const item of scored) {
      if (out.length >= limit) break
      const cost = item.entry.title.length + item.entry.content.length
      if (out.length > 0 && used + cost > budget) break
      out.push({ ...item, entry: cloneEntry(item.entry) })
      used += cost
    }
    return out
  }

  /** 软删除：保留审计痕迹。权限由 Policy 层检查，Memory 只执行存储语义。 */
  softDelete(id: string): boolean {
    const entry = [...this.#episodic, ...this.#user].find((e) => e.id === id)
    if (!entry || entry.deletedAtSim !== null) return false
    entry.deletedAtSim = this.#clock.nowSim()
    return true
  }

  exportAll(opts: { includeDeleted?: boolean } = {}): MemoryExport {
    const pick = (list: MemoryEntry[]) =>
      list
        .filter((e) => (opts.includeDeleted ? true : e.deletedAtSim === null))
        .map(cloneEntry)
    return {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      exportedAtWall: this.#clock.nowWall().toISOString(),
      exportedAtSim: this.#clock.nowSim(),
      profile: structuredClone(this.#profile),
      episodic: pick(this.#episodic),
      user: pick(this.#user),
      dynamicState: structuredClone(this.#dynamic),
      relationship: structuredClone(this.#relationship),
    }
  }

  /* ----------------------------------------------------------- dynamic state */

  getDynamicState(): CharacterDynamicState {
    return structuredClone(this.#dynamic)
  }

  setDynamicState(next: CharacterDynamicState): void {
    this.#dynamic = structuredClone(next)
  }

  getRelationship(): RelationshipState {
    return structuredClone(this.#relationship)
  }

  setRelationship(next: RelationshipState): void {
    this.#relationship = structuredClone(next)
  }

  /* ------------------------------------------------------------ persistence */

  toJSON(): unknown {
    return {
      episodic: this.#episodic.map(cloneEntry),
      user: this.#user.map(cloneEntry),
      dynamicState: this.#dynamic,
      relationship: this.#relationship,
    }
  }

  fromJSON(value: unknown): void {
    const v = value as {
      episodic?: MemoryEntry[]
      user?: MemoryEntry[]
      dynamicState?: CharacterDynamicState
      relationship?: RelationshipState
    }
    if (!v || typeof v !== 'object') throw new Error('memory section 结构非法')
    this.#episodic = (v.episodic ?? []).map(cloneEntry)
    this.#user = (v.user ?? []).map(cloneEntry)
    if (v.dynamicState) this.#dynamic = structuredClone(v.dynamicState)
    if (v.relationship) this.#relationship = structuredClone(v.relationship)
  }

  /* ----------------------------------------------------------------- helpers */

  /** 内存保护：超出容量时淘汰「显著度低 + 最旧 + 未确认」的条目。 */
  #enforceCapacity(): void {
    const total = this.#episodic.length + this.#user.length
    if (total <= MAX_ENTRIES) return

    const evictable = [...this.#episodic, ...this.#user]
      .filter((e) => e.deletedAtSim !== null || !e.confirmed || e.salience < 0.6)
      .sort((a, b) => a.salience - b.salience || a.createdAtSim - b.createdAtSim)

    let overflow = total - MAX_ENTRIES
    for (const victim of evictable) {
      if (overflow <= 0) break
      const bucket = victim.kind === 'episodic' ? this.#episodic : this.#user
      const idx = bucket.findIndex((e) => e.id === victim.id)
      if (idx >= 0) {
        bucket.splice(idx, 1)
        overflow--
      }
    }
  }
}

function cloneEntry(e: MemoryEntry): MemoryEntry {
  return { ...e, tags: [...e.tags] }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}
