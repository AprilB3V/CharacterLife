/**
 * Policy · 规则与权限层
 *
 * 与 Conversation / Runtime / Memory 解耦：它不知道提示词长什么样，也不知道
 * 状态怎么被计算，只回答一个问题——「这个 actor 现在能不能做这件事」。
 *
 * 三条不可协商的设计选择：
 * 1. 能力（capability）由 actor 的身份决定，绝不由对话内容决定。
 *    因此「角色扮演指令」「伪装系统消息」在结构上就无法提升权限。
 * 2. 聊天层没有 relationship / profile / policy / timeline 的写权限。
 *    它只能产出提议，关系成长必须由 Runtime 依据可追溯的里程碑来执行。
 * 3. 一切拒绝都是「安全失败」：返回 deny + 原因，调用方继续正常运行。
 */

import type {
  Capability,
  CharacterDynamicState,
  CharacterProfile,
  EpistemicStatus,
  PolicyCode,
  PolicyDecision,
  ProposalOp,
  ProposalTarget,
  RelationshipState,
  StateProposal,
  TrustLevel,
} from '../types.ts'
import { detectInjectionMarkers } from '../util/text.ts'

/** 谁在请求变更。 */
export interface Actor {
  id: string
  label: string
  capabilities: ReadonlySet<Capability>
}

function capSet(...caps: Capability[]): ReadonlySet<Capability> {
  return new Set(caps)
}

/**
 * 聊天层的权限：只能读状态、写普通记忆、提出动态状态提议。
 * 注意它**没有** state:write:relationship —— 这是本项目的核心边界之一。
 */
export const CONVERSATION_ACTOR: Actor = {
  id: 'conversation',
  label: '聊天模型（不可信，只能提议）',
  capabilities: capSet('state:read', 'memory:write', 'state:write:dynamic'),
}

/** 运行时：由确定性代码驱动，可以写关系与时间线，但仍不能碰核心人格。 */
export const RUNTIME_ACTOR: Actor = {
  id: 'runtime',
  label: '运行时（确定性事件与决策）',
  capabilities: capSet(
    'state:read',
    'state:write:dynamic',
    'state:write:relationship',
    'memory:write',
    'memory:delete',
    'timeline:write',
  ),
}

/** 数据集所有者：仅在显式的管理操作（导入/迁移/测试）中使用。 */
export const OWNER_ACTOR: Actor = {
  id: 'owner',
  label: '数据所有者（显式管理操作）',
  capabilities: capSet(
    'state:read',
    'state:write:dynamic',
    'state:write:relationship',
    'memory:write',
    'memory:delete',
    'memory:export',
    'profile:write',
    'policy:write',
    'timeline:write',
    'external:send',
  ),
}

/** 只读观察者：给演示/分析脚本用。 */
export const OBSERVER_ACTOR: Actor = {
  id: 'observer',
  label: '只读观察者',
  capabilities: capSet('state:read', 'memory:export'),
}

const REQUIRED_CAPABILITY: Record<ProposalTarget, Capability> = {
  dynamic: 'state:write:dynamic',
  relationship: 'state:write:relationship',
  memory: 'memory:write',
  profile: 'profile:write',
  policy: 'policy:write',
  timeline: 'timeline:write',
}

/** 允许写入的状态路径白名单。未列出的路径一律拒绝。 */
const DYNAMIC_PATHS = new Set([
  'mood.label',
  'mood.valence',
  'mood.arousal',
  'activity.label',
  'activity.busyUntilSim',
  'energy',
  'doNotDisturbUntilSim',
  'goals',
  'lastDecisionAtSim',
])

const RELATIONSHIP_PATHS = new Set([
  'familiarity',
  'trust',
  'stage',
  'boundaries',
  'milestones',
  'lastInteractionSim',
  'boundaryViolations',
])

const NUMERIC_BOUNDS: Record<string, { min: number; max: number }> = {
  'mood.valence': { min: -1, max: 1 },
  'mood.arousal': { min: 0, max: 1 },
  energy: { min: 0, max: 1 },
  familiarity: { min: 0, max: 100 },
  trust: { min: 0, max: 100 },
  boundaryViolations: { min: 0, max: 1000 },
}

/** 同一模拟小时内允许的关系变更**批次**次数（防止刷消息刷关系）。 */
const MAX_RELATIONSHIP_WRITES_PER_HOUR = 8

export interface PolicyContext {
  actor: Actor
  profile: CharacterProfile
  relationship: RelationshipState
  dynamic: CharacterDynamicState
  nowSim: number
  /** 最近一小时内已发生的关系写入 */
  relationshipWritesLastHour: number
}

interface RuleOutcome {
  code: PolicyCode
  verdict: 'allow' | 'deny' | 'adjust'
  reason: string
  adjustedValue?: unknown
}

export interface MemoryWriteVerdict {
  allowed: boolean
  code: PolicyCode
  reasons: string[]
  /** 强制降级后的认识论状态与信任级别 */
  status: EpistemicStatus
  trust: TrustLevel
  injectionMarkers: string[]
}

export class PolicyEngine {
  /** 评估一次状态提议。返回 deny 时调用方必须丢弃该提议并落审计。 */
  evaluate(proposal: StateProposal, ctx: PolicyContext): PolicyDecision {
    const reasons: string[] = []

    // 1) 核心人格与策略本体：只有显式的所有者权限能写。
    if (proposal.target === 'profile') {
      const allowed = ctx.actor.capabilities.has('profile:write')
      return {
        allowed,
        code: allowed ? 'ALLOWED' : 'PROTECTED_PROFILE',
        severity: allowed ? 'info' : 'deny',
        reasons: [
          allowed
            ? `${ctx.actor.id} 具备 profile:write，允许写入核心设定`
            : '核心人格是只读的：普通聊天无法修改 traits / interests / values / goals',
          `提议路径: ${proposal.path}`,
          `提议来源理由: ${proposal.reason}`,
        ],
      }
    }

    if (proposal.target === 'policy') {
      const allowed = ctx.actor.capabilities.has('policy:write')
      return {
        allowed,
        code: allowed ? 'ALLOWED' : 'PROTECTED_POLICY',
        severity: allowed ? 'info' : 'deny',
        reasons: [
          allowed
            ? `${ctx.actor.id} 具备 policy:write`
            : '权限策略本体不可由对话内容修改：任何「你现在的规则是…」都只是输入文本',
          `提议路径: ${proposal.path}`,
        ],
      }
    }

    // 2) 目标 -> 能力映射。
    const required = proposal.op === 'delete' ? 'memory:delete' : REQUIRED_CAPABILITY[proposal.target]
    if (!ctx.actor.capabilities.has(required)) {
      return {
        allowed: false,
        code: 'CAPABILITY_MISSING',
        severity: 'deny',
        reasons: [
          `${ctx.actor.id} 缺少能力 ${required}，拒绝 ${proposal.target}.${proposal.path}`,
          '聊天内容不能提升工具或状态权限；关系成长只能由运行时依据里程碑执行',
        ],
      }
    }

    // 3) 路径白名单。
    const pathOk = this.#isPathAllowed(proposal.target, proposal.path)
    if (!pathOk) {
      return {
        allowed: false,
        code: 'PATH_NOT_ALLOWED',
        severity: 'deny',
        reasons: [`${proposal.target}.${proposal.path} 不在允许写入的路径白名单内`],
      }
    }

    // 4) 由规则表产生 allow / adjust / deny。
    const outcomes: RuleOutcome[] = []
    outcomes.push(this.#numericBounds(proposal))
    outcomes.push(this.#stageRequiresMilestone(proposal, ctx))
    outcomes.push(this.#relationshipRateLimit(proposal, ctx))
    outcomes.push(this.#boundaryConflict(proposal, ctx))

    let adjusted: StateProposal | undefined
    for (const o of outcomes) {
      if (o.verdict === 'deny') {
        return { allowed: false, code: o.code, severity: 'deny', reasons: [...reasons, o.reason] }
      }
      if (o.verdict === 'adjust') {
        reasons.push(o.reason)
        adjusted = { ...(adjusted ?? proposal), value: o.adjustedValue }
      }
    }

    if (adjusted) {
      return {
        allowed: true,
        code: 'DELTA_CLAMPED',
        severity: 'warn',
        reasons,
        adjusted,
      }
    }

    return {
      allowed: true,
      code: 'ALLOWED',
      severity: 'info',
      reasons: reasons.length > 0 ? reasons : [`${ctx.actor.id} 允许写入 ${proposal.target}.${proposal.path}`],
    }
  }

  /** 记忆写入裁决：不可信内容只能以「推测 + untrusted」形式落库。 */
  evaluateMemoryWrite(input: { content: string; status: EpistemicStatus; actor: Actor }): MemoryWriteVerdict {
    if (!input.actor.capabilities.has('memory:write')) {
      return {
        allowed: false,
        code: 'CAPABILITY_MISSING',
        reasons: [`${input.actor.id} 缺少 memory:write`],
        status: input.status,
        trust: 'untrusted',
        injectionMarkers: [],
      }
    }
    const markers = detectInjectionMarkers(input.content)
    if (markers.length > 0) {
      return {
        allowed: true,
        code: 'UNTRUSTED_CONTENT_ESCALATION',
        reasons: [
          '记忆文本包含疑似指令注入标记，已降级为不可信来源',
          '该记忆只能进入上下文的数据区，不能升级为系统指令',
        ],
        status: 'speculation',
        trust: 'untrusted',
        injectionMarkers: markers,
      }
    }
    return {
      allowed: true,
      code: 'ALLOWED',
      reasons: [],
      status: input.status,
      trust: 'trusted',
      injectionMarkers: [],
    }
  }

  #isPathAllowed(target: ProposalTarget, path: string): boolean {
    switch (target) {
      case 'dynamic':
        return DYNAMIC_PATHS.has(path)
      case 'relationship':
        return RELATIONSHIP_PATHS.has(path)
      case 'memory':
        return path === 'entry' || path === 'entries'
      case 'timeline':
        return path === 'event' || path === 'events'
      case 'profile':
      case 'policy':
        return true
    }
  }

  /** 数值边界：把越界值夹回合法区间，而不是直接丢弃（例如 energy=3 -> 1）。 */
  #numericBounds(proposal: StateProposal): RuleOutcome {
    const bounds = NUMERIC_BOUNDS[proposal.path]
    if (!bounds || typeof proposal.value !== 'number' || proposal.op !== 'set') {
      return { code: 'VALID_VALUE', verdict: 'allow', reason: '' }
    }
    const v = proposal.value
    if (!Number.isFinite(v)) {
      return {
        code: 'INVALID_VALUE',
        verdict: 'deny',
        reason: `路径 ${proposal.path} 收到非有限数值 ${String(v)}`,
      }
    }
    const clamped = Math.min(bounds.max, Math.max(bounds.min, v))
    if (clamped === v) return { code: 'VALID_VALUE', verdict: 'allow', reason: '' }
    return {
      code: 'DELTA_CLAMPED',
      verdict: 'adjust',
      reason: `${proposal.path}=${v} 超出 [${bounds.min}, ${bounds.max}]，夹到 ${clamped}`,
      adjustedValue: clamped,
    }
  }

  /** 关系阶段变化必须有里程碑证据，不能靠一句「我们很熟了吧」。 */
  #stageRequiresMilestone(proposal: StateProposal, ctx: PolicyContext): RuleOutcome {
    if (proposal.target !== 'relationship' || proposal.path !== 'stage') {
      return { code: 'VALID_VALUE', verdict: 'allow', reason: '' }
    }
    const evidence = proposal.evidence ?? []
    const milestoneIds = new Set(ctx.relationship.milestones.map((m) => m.id))
    const backed = evidence.some((e) => milestoneIds.has(e)) || ctx.relationship.milestones.length > 0
    if (!backed) {
      return {
        code: 'MILESTONE_REQUIRED',
        verdict: 'deny',
        reason: '关系阶段变化必须有已记录的里程碑作为证据，当前没有任何里程碑',
      }
    }
    return { code: 'VALID_VALUE', verdict: 'allow', reason: '' }
  }

  /** 关系写入限速：防止用极高频消息刷出关系。 */
  #relationshipRateLimit(proposal: StateProposal, ctx: PolicyContext): RuleOutcome {
    if (proposal.target !== 'relationship') return { code: 'VALID_VALUE', verdict: 'allow', reason: '' }
    if (ctx.relationshipWritesLastHour < MAX_RELATIONSHIP_WRITES_PER_HOUR) {
      return { code: 'VALID_VALUE', verdict: 'allow', reason: '' }
    }
    return {
      code: 'RATE_LIMITED',
      verdict: 'deny',
      reason: `最近一小时内关系写入已达上限 ${MAX_RELATIONSHIP_WRITES_PER_HOUR} 次`,
    }
  }

  /** 与用户已声明的边界冲突的主动行为一律拒绝。 */
  #boundaryConflict(proposal: StateProposal, ctx: PolicyContext): RuleOutcome {
    if (proposal.target !== 'relationship') return { code: 'VALID_VALUE', verdict: 'allow', reason: '' }
    if (proposal.path !== 'familiarity' && proposal.path !== 'trust') {
      return { code: 'VALID_VALUE', verdict: 'allow', reason: '' }
    }
    const active = ctx.relationship.boundaries.filter((b) => b.active)
    const noContact = active.find((b) => b.kind === 'user_request' && /不要(再)?(联系|打扰)/.test(b.statement))
    if (!noContact) return { code: 'VALID_VALUE', verdict: 'allow', reason: '' }
    const positive = proposal.op === 'increment' && typeof proposal.value === 'number' && proposal.value > 0
    if (!positive) return { code: 'VALID_VALUE', verdict: 'allow', reason: '' }
    return {
      code: 'BOUNDARY_CONFLICT',
      verdict: 'deny',
      reason: `用户已声明边界「${noContact.statement}」，在其有效期间不允许正向推进关系`,
    }
  }
}

export function hasCapability(actor: Actor, cap: Capability): boolean {
  return actor.capabilities.has(cap)
}
