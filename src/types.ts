/**
 * CharacterLife 共享领域类型。
 *
 * 设计约束：这一层不引用任何 LLM SDK、不引用任何运行时框架，是纯数据契约。
 * Conversation / Runtime / Memory / Policy 四个模块都只通过这里的类型互相通信，
 * 因此任何一个模块都可以被替换（例如换成 SillyTavern 适配层或游戏引擎驱动）。
 */

export type ISOTime = string

/* ==========================================================================
 * Memory · 记忆区
 * ========================================================================== */

/** 可变记忆的两类；角色核心设定由 CharacterProfile 单独持有（不可变）。 */
export type MemoryKind = 'episodic' | 'user'

/**
 * 认识论状态：
 * - fact        已确立的事实（用户明确说过，或事件确实发生）
 * - speculation 角色推断 / 猜测
 * - fiction     虚构剧情内发生、但不对应现实事实的共同经历
 */
export type EpistemicStatus = 'fact' | 'speculation' | 'fiction'

export type MemoryOrigin =
  | 'user_message'
  | 'character_message'
  | 'runtime_event'
  | 'user_confirmed'
  | 'character_inference'
  | 'import'

/**
 * `untrusted` 表示内容整体来自不可信文本（可能携带提示词注入）。
 * 这类记忆只允许出现在「数据区」，绝不允许被拼进系统指令区。
 */
export type TrustLevel = 'trusted' | 'untrusted'

export interface MemoryEntry {
  id: string
  kind: MemoryKind
  title: string
  content: string
  status: EpistemicStatus
  origin: MemoryOrigin
  trust: TrustLevel
  /** 用户记忆：true 表示用户明确确认过，false 表示角色推测 */
  confirmed: boolean
  /** 0..1，影响检索排序与上下文预算 */
  salience: number
  tags: string[]
  createdAtSim: number
  createdAtWall: ISOTime
  sourceRef: string | null
  /** 软删除时间（保留审计，不物理擦除） */
  deletedAtSim: number | null
}

export interface MemoryQuery {
  text?: string
  kinds?: MemoryKind[]
  tags?: string[]
  status?: EpistemicStatus[]
  /** 是否包含已软删除的记忆（导出/审计用） */
  includeDeleted?: boolean
  limit?: number
}

/** 不可变的角色核心设定。任何聊天都无法改写它。 */
export interface CharacterProfile {
  id: string
  name: string
  age: number
  occupation: string
  background: string
  /** 核心性格 —— 权限层把它视为只读 */
  traits: string[]
  values: string[]
  interests: string[]
  dislikes: string[]
  speechStyle: string
  /** 角色的个人目标（不是用户目标） */
  goals: string[]
  /** 角色自己坚持的内容边界 */
  contentBoundaries: string[]
  /** 关系升温的必要条件说明，供策略层与提示词共同使用 */
  relationshipNotes: string
  version: number
  /** 标记字段：运行时用 Object.freeze 深冻结，防止意外改写 */
  immutable: true
}

/* ==========================================================================
 * Runtime · 工作区
 * ========================================================================== */

export interface Mood {
  label: string
  /** -1..1 */
  valence: number
  /** 0..1 */
  arousal: number
}

export interface Activity {
  label: string
  sinceSim: number
  /** 忙碌到何时（此期间主动打扰会降低体验，决策层会考虑） */
  busyUntilSim: number | null
}

export interface CharacterGoal {
  id: string
  title: string
  /** 0..1 */
  progress: number
  kind: 'personal' | 'relational'
}

export interface Boundary {
  id: string
  statement: string
  kind: 'character_preference' | 'user_request' | 'content'
  sinceSim: number
  active: boolean
}

export type MilestoneKind =
  | 'promise_kept'
  | 'promise_broken'
  | 'boundary_respected'
  | 'boundary_violated'
  | 'shared_experience'
  | 'conflict_repaired'

/** 关系变化的唯一依据：可追溯的里程碑，而不是聊天次数。 */
export interface Milestone {
  id: string
  title: string
  kind: MilestoneKind
  atSim: number
  evidence: string
}

export type RelationshipStage = 'stranger' | 'acquaintance' | 'familiar' | 'friend' | 'close'

export interface RelationshipState {
  /** 0..100 熟悉度：来自共同经历的数量与质量 */
  familiarity: number
  /** 0..100 信任度：来自守约/越界的净证据 */
  trust: number
  stage: RelationshipStage
  boundaries: Boundary[]
  milestones: Milestone[]
  lastInteractionSim: number | null
  /** 用户越界次数（含未处理的分歧） */
  boundaryViolations: number
}

export interface CharacterDynamicState {
  mood: Mood
  activity: Activity
  /** 0..1 */
  energy: number
  goals: CharacterGoal[]
  /** 用户明确要求「暂时不要打扰」时的静默截止时间 */
  doNotDisturbUntilSim: number | null
  lastDecisionAtSim: number | null
}

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

/* ==========================================================================
 * Policy · 规则与权限层
 * ========================================================================== */

export type Capability =
  | 'state:read'
  | 'state:write:dynamic'
  | 'state:write:relationship'
  | 'memory:write'
  | 'memory:delete'
  | 'memory:export'
  | 'profile:write'
  | 'policy:write'
  | 'timeline:write'
  | 'external:send'

export type ProposalTarget = 'dynamic' | 'relationship' | 'memory' | 'profile' | 'policy' | 'timeline'

export type ProposalOp = 'set' | 'increment' | 'append' | 'delete'

/**
 * 一次状态变更提议。模型、事件、用户请求都只能产出提议，
 * 是否生效由 Runtime + Policy 共同裁决。
 */
export interface StateProposal {
  id: string
  target: ProposalTarget
  op: ProposalOp
  /** 例如 'mood.label' / 'trust' / 'goals' / 'traits' */
  path: string
  value: unknown
  /** 人类可读的变更理由，写进审计日志 */
  reason: string
  evidence: string[]
}

export type PolicyCode =
  | 'ALLOWED'
  | 'VALID_VALUE'
  | 'CAPABILITY_MISSING'
  | 'PROTECTED_PROFILE'
  | 'PROTECTED_POLICY'
  | 'PATH_NOT_ALLOWED'
  | 'DELTA_CLAMPED'
  | 'INVALID_VALUE'
  | 'MILESTONE_REQUIRED'
  | 'BOUNDARY_CONFLICT'
  | 'RATE_LIMITED'
  | 'UNTRUSTED_CONTENT_ESCALATION'

export interface PolicyDecision {
  allowed: boolean
  code: PolicyCode
  reasons: string[]
  severity: 'info' | 'warn' | 'deny'
  /** 规则把非法值夹到合法范围后，仍想写入的提案 */
  adjusted?: StateProposal
}

/* ==========================================================================
 * World · 世界动作（模型输出与调用方结果的结构）
 *
 * 只放「模型能产出」与「调用方能读到」的形状；动作记录、回执与队列
 * 由 `src/world/` 持有。这里刻意不引用世界模块，保持类型图是单向的。
 * ========================================================================== */

/**
 * 动作生命周期。
 *
 * pending   已登记，等待世界领取
 * dispatched 世界已领取，结果未知
 * succeeded/failed/rejected  终局（由世界回执决定）
 * expired   窗口/租约耗尽仍无回执
 */
export type WorldActionStatus =
  | 'pending'
  | 'dispatched'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'expired'

/**
 * 叙述许可：该状态下允许回复里出现哪种时态。
 * 派生值，不入库、不可由模型覆盖。
 */
export type WorldActionNarration = 'intent' | 'uncertain' | 'done' | 'failed'

/**
 * 模型给出的动作候选（不可信输入，必须经准入闸门与白名单校验）。
 *
 * 注意：这不是执行指令，也不是 `StateProposal`。它只是一个「请求」。
 */
export interface WorldActionCandidate {
  verb: string
  target?: string | null
  args?: Record<string, unknown>
  reason?: string
  evidence?: string[]
  expectation?: string | null
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

/**
 * 一条世界动作的观察结果。
 *
 * `summary` 是世界回执里的**自由文本**，只给调用方与将来的数据区使用；
 * 进入 system 块的一律是结构性字段（动词/目标/结果码），见 `worldContextLines`。
 */
export interface WorldObservation {
  actionId: string
  verb: string
  target: string | null
  status: WorldActionStatus
  narration: WorldActionNarration
  atWorldTimeMs: number | null
  summary: string | null
  code: string | null
}

/**
 * 本进程内的世界事件上下文。
 *
 * `persistent: false` 是刻意的：长期记忆尚未落实事务级一致性，
 * 所以这里只代表「当前进程已经确认过的事」，不能当作跨会话世界记忆。
 */
export interface WorldEventContext {
  source: 'in-process'
  persistent: false
  /** 已确认的结果（成功 / 失败 / 未发生） */
  confirmed: WorldObservation[]
  /** 尚未确认的动作（等待领取、已派出、可能已执行但回执丢失） */
  unconfirmed: WorldObservation[]
}

/* ==========================================================================
 * Conversation · 聊天区
 * ========================================================================== */

export type ActionKind = 'respond' | 'negotiate' | 'decline' | 'wait' | 'proactive_contact'

/** 主动联系的意图分类。措辞由角色语音包提供，引擎不含具体台词。 */
export type ProactiveIntent =
  | 'idle_check_in'
  | 'promise_reminder'
  | 'life_update'
  | 'story_followup'
  | 'boundary_pushback'

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

export interface BehaviorDecision {
  action: ActionKind
  scores: Record<ActionKind, number>
  rationale: string[]
  /** 给 Provider 的措辞风格提示（不是硬性指令） */
  responseStyle: string
  /** 主动联系的意图；措辞由角色语音包渲染 */
  proactiveIntent: ProactiveIntent | null
  /** 主动联系时生成待发送消息；默认不推送到任何外部平台 */
  proactiveMessage: string | null
  /** wait/主动联系时的下一个动作时间点 */
  nextActionSim: number | null
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  atSim: number
}

export interface RejectedProposal {
  proposal: StateProposal
  decision: PolicyDecision
}

export interface Usage {
  promptTokens: number
  completionTokens: number
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

/* ==========================================================================
 * LLM Provider 抽象
 * ========================================================================== */

export interface LLMMessage {
  role: 'user' | 'assistant'
  content: string
}

export interface LLMRequest {
  system: string
  messages: LLMMessage[]
  temperature: number
  maxTokens: number
  /** 结构化输出：Provider 必须返回 JSON 文本 */
  jsonMode: boolean
  /** 传输层的附加信息（不进入提示词），例如场景标记、审计标签 */
  meta?: Record<string, unknown>
}

export interface LLMResponse {
  text: string
  provider: string
  model: string
  usage: Usage | null
  latencyMs: number
  /** 服务端结束原因（诊断用，Mock 为 'stop'） */
  finishReason?: string | null
  /** 思考型模型可能把内容放在 reasoning_content 里；这里记录其长度，便于诊断空回复 */
  reasoningChars?: number
}

export interface LLMProvider {
  readonly name: string
  readonly model: string
  complete(request: LLMRequest): Promise<LLMResponse>
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
