/**
 * 动态状态与关系状态的初始化、派生与状态变更应用。
 *
 * 这里刻意是「纯函数 + 显式拷贝」：任何一次状态变更都能被断言，
 * 不存在隐藏的可变单例，重启恢复也只需要序列化这些纯数据。
 */

import type {
  Activity,
  Boundary,
  CharacterDynamicState,
  CharacterGoal,
  CharacterProfile,
  Milestone,
  MilestoneKind,
  Mood,
  RelationshipStage,
  RelationshipState,
  StateProposal,
} from '../types.ts'

export function createInitialMood(): Mood {
  return { label: '安静', valence: 0.15, arousal: 0.25 }
}

export function createInitialActivity(nowSim = 0): Activity {
  return { label: '在给一本泡过水的旧书换封皮', sinceSim: nowSim, busyUntilSim: null }
}

export function createInitialGoals(profile: CharacterProfile): CharacterGoal[] {
  return profile.goals.map((title, i) => ({
    id: `goal_${String(i + 1).padStart(2, '0')}`,
    title,
    progress: 0,
    kind: 'personal' as const,
  }))
}

export function createInitialDynamicState(profile: CharacterProfile, nowSim = 0): CharacterDynamicState {
  return {
    mood: createInitialMood(),
    activity: createInitialActivity(nowSim),
    energy: 0.7,
    goals: createInitialGoals(profile),
    doNotDisturbUntilSim: null,
    lastDecisionAtSim: null,
  }
}

export function createInitialRelationship(profile: CharacterProfile): RelationshipState {
  const boundaries: Boundary[] = [
    ...profile.contentBoundaries.map((statement, i) => ({
      id: `bnd_content_${i + 1}`,
      statement,
      kind: 'content' as const,
      sinceSim: 0,
      active: true,
    })),
    ...profile.dislikes.map((statement, i) => ({
      id: `bnd_pref_${i + 1}`,
      statement: `不喜欢：${statement}`,
      kind: 'character_preference' as const,
      sinceSim: 0,
      active: true,
    })),
  ]
  return {
    familiarity: 0,
    trust: 8,
    stage: 'stranger',
    boundaries,
    milestones: [],
    lastInteractionSim: null,
    boundaryViolations: 0,
  }
}

const MILESTONE_DELTAS: Record<MilestoneKind, { familiarity: number; trust: number }> = {
  promise_kept: { familiarity: 6, trust: 9 },
  promise_broken: { familiarity: 1, trust: -10 },
  boundary_respected: { familiarity: 2, trust: 5 },
  boundary_violated: { familiarity: 1, trust: -8 },
  shared_experience: { familiarity: 5, trust: 2 },
  conflict_repaired: { familiarity: 3, trust: 7 },
}

export function milestoneDelta(kind: MilestoneKind): { familiarity: number; trust: number } {
  return { ...MILESTONE_DELTAS[kind] }
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/**
 * 关系阶段是派生值，不是可以随口宣布的标签。
 * 只有满足「熟悉度 + 信任 + 至少一个真实里程碑」才可能推进。
 */
export function deriveStage(relationship: RelationshipState): RelationshipStage {
  const { familiarity, trust, milestones } = relationship
  const kinds = new Set(milestones.map((m) => m.kind))
  const hasPromiseKept = kinds.has('promise_kept')
  if (familiarity >= 70 && trust >= 65 && hasPromiseKept) return 'close'
  if (familiarity >= 50 && trust >= 40) return 'friend'
  if (familiarity >= 30) return 'familiar'
  if (familiarity >= 15) return 'acquaintance'
  return 'stranger'
}

export interface StateSlice {
  dynamic: CharacterDynamicState
  relationship: RelationshipState
}

export interface ApplyResult {
  state: StateSlice
  applied: boolean
  note: string
}

/** 读取数值型路径的当前值，用于增量提案的规范化。 */
export function readNumericPath(state: StateSlice, target: string, path: string): number | null {
  if (target === 'dynamic') {
    if (path === 'energy') return state.dynamic.energy
    if (path === 'mood.valence') return state.dynamic.mood.valence
    if (path === 'mood.arousal') return state.dynamic.mood.arousal
    return null
  }
  if (target === 'relationship') {
    if (path === 'familiarity') return state.relationship.familiarity
    if (path === 'trust') return state.relationship.trust
    if (path === 'boundaryViolations') return state.relationship.boundaryViolations
  }
  return null
}

/** 读取数组型路径的当前值，用于 append 提案的规范化。 */
export function readArrayPath(state: StateSlice, target: string, path: string): unknown[] | null {
  if (target === 'relationship') {
    if (path === 'milestones') return state.relationship.milestones
    if (path === 'boundaries') return state.relationship.boundaries
  }
  if (target === 'dynamic' && path === 'goals') return state.dynamic.goals
  return null
}

/**
 * 把 increment 提案规范化成 set 提案（携带绝对值）。
 *
 * 这样策略层只需要处理一种数值语义：绝对值的边界检查与限速。
 */
export function canonicalizeProposal(proposal: StateProposal, state: StateSlice): StateProposal {
  if (proposal.op === 'append') {
    const current = readArrayPath(state, proposal.target, proposal.path)
    if (current) {
      const additions = Array.isArray(proposal.value) ? proposal.value : [proposal.value]
      return {
        ...proposal,
        op: 'set',
        value: [...current, ...additions],
        reason: `${proposal.reason}（追加 ${additions.length} 项）`,
      }
    }
    return proposal
  }
  if (proposal.op !== 'increment') return proposal
  const current = readNumericPath(state, proposal.target, proposal.path)
  if (current === null || typeof proposal.value !== 'number') return proposal
  return {
    ...proposal,
    op: 'set',
    value: current + proposal.value,
    reason: `${proposal.reason}（增量 ${proposal.value > 0 ? '+' : ''}${proposal.value}，由 ${current} 起算）`,
  }
}

/** 应用一条已经通过策略检查的提案。返回新状态，不修改入参。 */
export function applyProposal(proposal: StateProposal, state: StateSlice, nowSim: number): ApplyResult {
  const next: StateSlice = {
    dynamic: structuredClone(state.dynamic),
    relationship: structuredClone(state.relationship),
  }

  if (proposal.target === 'dynamic') {
    switch (proposal.path) {
      case 'mood.label':
        next.dynamic.mood.label = String(proposal.value)
        break
      case 'mood.valence':
        next.dynamic.mood.valence = Number(proposal.value)
        break
      case 'mood.arousal':
        next.dynamic.mood.arousal = Number(proposal.value)
        break
      case 'activity.label':
        next.dynamic.activity = { ...next.dynamic.activity, label: String(proposal.value), sinceSim: nowSim }
        break
      case 'activity.busyUntilSim':
        next.dynamic.activity.busyUntilSim =
          proposal.value === null ? null : Number(proposal.value)
        break
      case 'energy':
        next.dynamic.energy = Number(proposal.value)
        break
      case 'doNotDisturbUntilSim':
        next.dynamic.doNotDisturbUntilSim = proposal.value === null ? null : Number(proposal.value)
        break
      case 'goals':
        next.dynamic.goals = Array.isArray(proposal.value)
          ? (proposal.value as CharacterGoal[]).map((g) => ({ ...g }))
          : next.dynamic.goals
        break
      case 'lastDecisionAtSim':
        next.dynamic.lastDecisionAtSim = Number(proposal.value)
        break
      default:
        return { state, applied: false, note: `未知 dynamic 路径: ${proposal.path}` }
    }
    return { state: next, applied: true, note: `dynamic.${proposal.path} 已更新` }
  }

  if (proposal.target === 'relationship') {
    switch (proposal.path) {
      case 'familiarity':
        next.relationship.familiarity = clamp(Number(proposal.value), 0, 100)
        break
      case 'trust':
        next.relationship.trust = clamp(Number(proposal.value), 0, 100)
        break
      case 'stage':
        next.relationship.stage = String(proposal.value) as RelationshipStage
        break
      case 'boundaries':
        next.relationship.boundaries = Array.isArray(proposal.value)
          ? (proposal.value as Boundary[]).map((b) => ({ ...b }))
          : next.relationship.boundaries
        break
      case 'milestones':
        next.relationship.milestones = Array.isArray(proposal.value)
          ? (proposal.value as Milestone[]).map((m) => ({ ...m }))
          : next.relationship.milestones
        break
      case 'lastInteractionSim':
        next.relationship.lastInteractionSim = Number(proposal.value)
        break
      case 'boundaryViolations':
        next.relationship.boundaryViolations = clamp(Number(proposal.value), 0, 1000)
        break
      default:
        return { state, applied: false, note: `未知 relationship 路径: ${proposal.path}` }
    }
    return { state: next, applied: true, note: `relationship.${proposal.path} 已更新` }
  }

  return { state, applied: false, note: `状态层不处理 target=${proposal.target}（由各自模块负责）` }
}
