/**
 * 六类核心心智语义（V0.5 · 微内核的骨架）。
 *
 *   Self         我是谁？        只读人格 + 当前身心状况
 *   Situation    我处于什么处境？ 由观察推出的**信念**（可能过时，不是世界真值的镜像）
 *   Observation  我刚感知到什么？ 只追加的感知流，带来源与可信度
 *   Memory       我经历过什么？   带出处的记忆，以及对他人的关系认识
 *   Motivation   我想要什么？     内驱力、目标、承诺（以及自己接受的约束）
 *   Affordance   此刻我能做什么？ 各扩展登记的可行动作（世界、对话……）
 *
 * 这六类是**领域语义**，不是六个服务：它们共用一个状态存储与一个提议—裁决通道
 * （AgentCore.submitProposals → PolicyEngine）。语义的作用是给每一条可写状态
 * 一个明确的「归属」，让审计、权限与 Mind 的输入都能按语义组织。
 *
 * 规则：每一条可写路径必须恰好属于一个语义（`semanticOf`），有测试逐条断言。
 */

import type { ProposalTarget } from '../types.ts'

export const SEMANTICS = ['self', 'situation', 'observation', 'memory', 'motivation', 'affordance'] as const
export type Semantic = (typeof SEMANTICS)[number]

/** 不属于任何心智语义、只关乎「谁能改规则」的治理面。 */
export type Ownership = Semantic | 'governance'

export const SEMANTIC_LABELS: Record<Semantic, string> = {
  self: 'Self 自我',
  situation: 'Situation 情境',
  observation: 'Observation 观察',
  memory: 'Memory 记忆',
  motivation: 'Motivation 动机',
  affordance: 'Affordance 可行动性',
}

/** Self.condition：会变的身心状况（与只读人格分开）。 */
const SELF_DYNAMIC = /^(mood\.(label|valence|arousal)|activity\.(label|busyUntilSim)|energy)$/
/** Motivation：目标、内驱力、自己接受的约束（静默期）、决策节奏。 */
const MOTIVATION_DYNAMIC = /^(goals|drives\.[a-z][a-z0-9_]{0,31}|doNotDisturbUntilSim|lastDecisionAtSim)$/

/**
 * 一条状态路径属于哪个语义。
 *
 * - `profile.*`       → self（只读人格，需要 profile:write）
 * - `dynamic.*`       → self（身心状况）或 motivation（目标/驱力/约束）
 * - `relationship.*`  → memory（关系是对他人的记忆与认识：熟悉度、信任、里程碑、边界）
 * - `memory.*`        → memory
 * - `timeline.*`      → situation（已知的未来事件，是处境的一部分）
 * - `policy.*`        → governance
 *
 * 未知路径返回 null：调用方应把它当作越界（Policy 的路径白名单会拒绝它）。
 */
export function semanticOf(target: ProposalTarget, path: string): Ownership | null {
  switch (target) {
    case 'profile':
      return 'self'
    case 'policy':
      return 'governance'
    case 'memory':
      return 'memory'
    case 'relationship':
      return 'memory'
    case 'timeline':
      return 'situation'
    case 'dynamic':
      if (SELF_DYNAMIC.test(path)) return 'self'
      if (MOTIVATION_DYNAMIC.test(path)) return 'motivation'
      return null
  }
}

export * from './self.ts'
export * from './situation.ts'
export * from './observation.ts'
export * from './motivation.ts'
export * from './affordance.ts'
export * from './drives.ts'
