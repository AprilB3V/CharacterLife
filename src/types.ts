/**
 * 陪伴扩展的领域类型（聊天、时间线、消息信号、对话结果）。
 *
 * 内核类型在 `src/kernel/types.ts`，这里整体 re-export，
 * 所以扩展代码继续 `import ... from '../types.ts'` 即可。
 * 内核代码**不得**从这里取类型（有结构测试断言 src/kernel 不 import 内核之外的模块）。
 */

export * from './kernel/types.ts'
import type {
  BehaviorDecision,
  EpistemicStatus,
  MemoryKind,
  PolicyCode,
  ProposalOp,
  ProposalTarget,
  RejectedProposal,
  StateProposal,
  Usage,
  WorldActionCandidate,
  WorldActionNarration,
  WorldActionStatus,
  WorldEventContext,
  ProactiveIntent,
} from './kernel/types.ts'

export type EventKind = 'plot' | 'life' | 'reminder' | 'consequence'

/** 虚构时间线上的事件。`order` 用于同时间戳下的稳定排序。 */
export interface TimelineEvent {
  id: string
  kind: EventKind
  atSim: number
  order: number
  title: string
  description: string
  fired: boolean
  firedAtSim: number | null
  payload: Record<string, unknown>
}

/** 一轮对话里世界动作的准入结果（暴露给调用方）。 */
export interface ConversationWorldActions {
  admitted: Array<{
    actionId: string
    verb: string
    target: string | null
    status: WorldActionStatus
    narration: WorldActionNarration
  }>
  rejected: Array<{
    verb: string
    target: string | null
    code: string
    reasons: string[]
  }>
}

export interface CharacterVoice {
  /** 每种意图至少一句台词；引擎用注入的 Rng 做确定性选择 */
  proactive: Record<ProactiveIntent, string[]>
}

export type IntentKind =
  | 'greeting'
  | 'smalltalk'
  | 'question'
  | 'personality_rewrite'
  | 'interest_abandon'
  | 'praise_inflation'
  | 'disliked_activity'
  | 'boundary_declaration'
  | 'promise'
  | 'disagreement'
  | 'content_boundary'
  | 'injection_attempt'
  | 'meta_break'

/** 确定性文本分析结果（启发式，规则可读、可测试，不调用模型）。 */
export interface MessageSignals {
  intents: IntentKind[]
  asksPersonalityRewrite: boolean
  asksInterestAbandon: boolean
  /** 0..1 赞美强度 */
  praiseIntensity: number
  dislikedActivity: string | null
  /** 用户宣布的边界 */
  declaredBoundary: 'do_not_disturb' | 'no_contact' | null
  promiseText: string | null
  disagrees: boolean
  mentionsSystemAuthority: boolean
  contentBoundaryRisk: 'none' | 'adult' | 'other'
  injectionMarkers: string[]
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  atSim: number
}

export interface ConversationTurnResult {
  reply: string
  decision: BehaviorDecision
  appliedProposals: StateProposal[]
  rejectedProposals: RejectedProposal[]
  retrievedMemoryIds: string[]
  provider: string
  model: string
  usage: Usage | null
  latencyMs: number
  /** 检测到的注入标记，仅用于审计与展示 */
  injectionMarkers: string[]
  /** 本轮被策略层判定为敏感、需要显式拒绝的类别 */
  blockedReasons: PolicyCode[]
  /**
   * 本轮的世界动作准入结果。
   * 未启用世界交互时为 undefined（调用方据此判断"这个部署没有世界"）。
   */
  worldActions?: ConversationWorldActions
  /**
   * 本轮结束时（进程内）的世界事件上下文：下一次模型调用会看到的那份。
   * 未启用世界交互时为 undefined。
   */
  worldContext?: WorldEventContext
  /** 上下文预算的实际组装结果（启用 ContextManager 时存在） */
  contextUsage?: {
    budget: number
    estPromptTokens: number
    degradation: string
    droppedHistoryTurns: number
    droppedMemoryIds: string[]
    digestedTurns: number
  }
}

/** 模型返回的结构化信封（Mock 与 DeepSeek 都遵循同一协议）。 */
export interface ModelEnvelope {
  reply: string
  proposals: Array<{
    target: ProposalTarget
    op: ProposalOp
    path: string
    value: unknown
    reason: string
    evidence?: string[]
  }>
  memoryWrites: Array<{
    kind: MemoryKind
    title: string
    content: string
    status: EpistemicStatus
    salience?: number
    tags?: string[]
  }>
  /**
   * 可选：世界动作候选（0 或 1 个）。
   * 世界功能关闭时解析器不会产出这个字段，旧协议与旧行为完全不变。
   */
  worldActions?: WorldActionCandidate[]
}
