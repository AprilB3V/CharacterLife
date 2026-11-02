/**
 * Motivation · 我想要什么，为什么？
 *
 * 三样东西，来源与生命周期各不相同：
 *   drives       内驱力：随时间上升的压力，只在世界确认成功时缓解（drives.ts）
 *   goals        长期目标（`dynamic.goals`，经提议写入）
 *   commitments  承诺账本：答应过谁、什么时候到期、现在是否有效
 *
 * 备忘录 §4 的要求：承诺的**当前状态**放在这里，**历史证据**放在 Memory。
 * 即使对话被压缩，角色也不必从过去的自然语言里重新推断待办事项。
 *
 * 承诺状态只能由运行时改变（兑现由外部证据确认；违约由到期判定），
 * Mind 只能提出新的承诺候选。
 */

import type { CharacterDynamicState, CharacterGoal, Commitment, CommitmentCriterion } from '../types.ts'
import type { DriveProfile, DriveReading } from './drives.ts'
import { readDrives } from './drives.ts'

export class MotivationSlot {
  #dynamic: () => CharacterDynamicState
  #now: () => number
  #drives: DriveProfile | null
  #commitments: Commitment[] = []

  constructor(opts: { dynamic: () => CharacterDynamicState; now: () => number; drives?: DriveProfile | null }) {
    this.#dynamic = opts.dynamic
    this.#now = opts.now
    this.#drives = opts.drives ?? null
  }

  /** 内驱力规格（角色配置）。未配置时 drives() 返回空数组。 */
  get driveProfile(): DriveProfile | null {
    return this.#drives
  }

  setDriveProfile(profile: DriveProfile | null): void {
    this.#drives = profile
  }

  drives(nowSim: number = this.#now()): DriveReading[] {
    return this.#drives ? readDrives(this.#drives, this.#dynamic(), nowSim) : []
  }

  goals(): CharacterGoal[] {
    return this.#dynamic().goals.map((g) => ({ ...g }))
  }

  /* ------------------------------------------------------------ 承诺账本 */

  commitments(): Commitment[] {
    return structuredClone(this.#commitments)
  }

  open(): Commitment[] {
    return structuredClone(this.#commitments.filter((c) => c.status === 'open'))
  }

  /** 到期（含已过期）仍未兑现的承诺。 */
  due(nowSim: number = this.#now()): Commitment[] {
    return structuredClone(this.#commitments.filter((c) => c.status === 'open' && c.dueAtSim <= nowSim))
  }

  get(id: string): Commitment | null {
    const c = this.#commitments.find((x) => x.id === id)
    return c ? structuredClone(c) : null
  }

  add(commitment: Commitment): Commitment {
    const stored = normalizeCommitment(commitment)
    this.#commitments.push(stored)
    return structuredClone(stored)
  }

  updateCriterion(id: string, criterion: CommitmentCriterion): boolean {
    const commitment = this.#commitments.find(item => item.id === id && item.status === 'open')
    if (!commitment) return false
    commitment.criterion = normalizeCriterion(criterion)
    return true
  }

  /** 结算一条仍然有效的承诺。已结算的不能再改（返回 false）。 */
  settle(id: string, status: 'kept' | 'broken', evidenceRef?: string): boolean {
    const c = this.#commitments.find((x) => x.id === id)
    if (!c || c.status !== 'open') return false
    c.status = status
    if (evidenceRef) c.evidenceRef = evidenceRef
    return true
  }

  toJSON(): Commitment[] {
    return this.commitments()
  }

  fromJSON(items: readonly Commitment[]): void {
    this.#commitments = items.map(normalizeCommitment)
  }
}

function normalizeCommitment(commitment: Commitment): Commitment {
  const copy = structuredClone(commitment)
  if (copy.criterion) copy.criterion = normalizeCriterion(copy.criterion)
  return copy
}

/**
 * Accepts both the current `{ kind, params }` shape and the pre-0.7 flat shape
 * (`{ kind, worldId, runId, ... }`), folding legacy fields into `params`.
 */
export function normalizeCriterion(criterion: CommitmentCriterion | Record<string, unknown>): CommitmentCriterion {
  const { kind, params, ...legacy } = structuredClone(criterion) as Record<string, unknown>
  const base = params !== null && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {}
  return { kind: String(kind ?? ''), params: { ...legacy, ...base } }
}
