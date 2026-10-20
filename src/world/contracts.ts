/**
 * 世界交互协议（第一阶段：HTTP 闭环 · 内存动作队列）
 *
 * 三平面分离（与 docs/WORLD_PROTOCOL.md 一致）：
 *   角色状态平面：人格 / 记忆 / 关系 / 动态状态（已有，本模块**不写**）
 *   意图平面：WorldActionProposal —— 由 CharacterLife 产生，CL-World 领取
 *   真值平面：WorldEvent —— 只能由 CL-World 产生，是唯一的事实来源
 *
 * 第一阶段的两条硬约束：
 * 1. 世界事件**不得**转换为聊天消息、`StateProposal` 或记忆条目。
 *    本模块没有任何 workspace / memory 的引用，这是结构性保证，不是靠调用方自觉。
 * 2. 动作队列只在内存中。进程重启即丢失，且**没有任何持久化承诺**；
 *    正式持久化（崩溃一致性、租约、迟到回执）在第二阶段单独实现。
 *
 * 注意：这里刻意不引入 `ActionKind` 或 `ProposalTarget` 的任何扩展。
 * 把世界动作塞进对话动作或状态提议，等于让外部副作用借用状态写入能力。
 */

/** CL-World 对一次动作的终局判定。第一阶段只支持这三种，不支持 partial。 */
export const WORLD_RESULTS = ['succeeded', 'failed', 'rejected'] as const
export type WorldActionResult = (typeof WORLD_RESULTS)[number]

export const WORLD_EVENT_KINDS = ['action_result', 'observation'] as const
export type WorldEventKind = (typeof WORLD_EVENT_KINDS)[number]

/**
 * 动作生命周期。
 *
 * pending   已登记，等待世界领取
 * dispatched 世界已领取，结果未知（有租约）
 * succeeded/failed/rejected  终局
 * expired   租约/窗口耗尽仍无回执（**不代表没发生**，见 narrationFor）
 */
export type WorldActionStatus =
  | 'pending'
  | 'dispatched'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'expired'

/**
 * 叙述许可：该状态下，回复里允许出现哪种时态。
 *
 * intent    只能说将来/意图（"我打算…"）
 * uncertain 只能说不知道结果（"还不知道"）
 * done      可以说已完成
 * failed    可以说没做成
 *
 * 这个值是**派生**的（narrationFor），不入库、不可由调用方覆盖。
 */
export type WorldActionNarration = 'intent' | 'uncertain' | 'done' | 'failed'

/** 准入失败原因（服务端产生动作时使用）。 */
export type WorldAdmitErrorCode =
  | 'WORLD_DISABLED'
  | 'WORLD_NOT_BOUND'
  | 'INSTANCE_NOT_FOUND'
  | 'INSTANCE_WORLD_MISMATCH'
  | 'VERB_NOT_ALLOWED'
  | 'TARGET_NOT_ALLOWED'
  | 'ARGS_INVALID'
  | 'ARGS_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'DUPLICATE_INTENT'

/** 世界回执被拒原因（逐条返回，不影响同批其它事件）。 */
export type WorldIngestErrorCode =
  | 'MALFORMED'
  | 'WORLD_MISMATCH'
  | 'UNSUPPORTED_KIND'
  | 'UNKNOWN_INSTANCE'
  | 'INSTANCE_WORLD_MISMATCH'
  | 'UNKNOWN_ACTION'
  | 'ACTION_INSTANCE_MISMATCH'
  | 'ACTION_ALREADY_SETTLED'

/** 一次动作提议的输入（由调用方提供，服务端负责补全身份与生命周期字段）。 */
export interface WorldActionSpec {
  verb: string
  target: string | null
  args: Record<string, unknown>
  /** 人类可读理由，只用于审计与后续叙述，不下发给世界 */
  reason: string
  evidence: string[]
  expectation: string | null
  /** 产生该动作的对话轮次；第一阶段恒为 null（还没有模型意图接入） */
  turnId: string | null
}

export interface WorldActionOutcome {
  eventId: string
  result: WorldActionResult
  code: string | null
  summary: string
  atWorldTimeMs: number
  receivedAtSim: number
}

/** 内部记录（含叙述不会下发的字段）。 */
export interface WorldActionRecord {
  id: string
  worldId: string
  instanceId: string
  verb: string
  target: string | null
  args: Record<string, unknown>
  reason: string
  evidence: string[]
  expectation: string | null
  status: WorldActionStatus
  correlationId: string
  turnId: string | null
  createdAtSim: number
  /** 绝对截止时刻：到点即关闭，与状态无关 */
  expiresAtSim: number
  firstDispatchedAtSim: number | null
  leaseExpiresAtSim: number | null
  attempts: number
  maxAttempts: number
  outcome: WorldActionOutcome | null
}

/** 对外视图（HTTP 与测试使用）。刻意不含 reason/evidence。 */
export interface WorldActionView {
  actionId: string
  correlationId: string
  instanceId: string
  worldId: string
  verb: string
  target: string | null
  args: Record<string, unknown>
  expectation: string | null
  status: WorldActionStatus
  narration: WorldActionNarration
  attempts: number
  maxAttempts: number
  createdAtSim: number
  expiresAtSim: number
  firstDispatchedAtSim: number | null
  leaseExpiresAtSim: number | null
  outcome: WorldActionOutcome | null
}

/**
 * CL-World 回执（整体视为不可信网络输入）。
 *
 * `worldId` 是**冗余声明**：可以省略，省略时以请求级 `worldId`（token 授权过的）为准。
 * 显式声明时只用于一致性校验 —— 服务端永远不采信客户端声明的世界归属。
 */
export interface WorldEvent {
  eventId: string
  worldId: string | null
  instanceId: string
  actionId: string | null
  kind: WorldEventKind
  result: WorldActionResult | null
  atWorldTimeMs: number
  summary: string
  facts: Array<{ key: string; value: string | number | boolean }>
  code: string | null
}

export interface WorldIngestResult {
  accepted: string[]
  duplicates: string[]
  rejected: Array<{ eventId: string; code: WorldIngestErrorCode; message: string }>
  /**
   * 第一阶段只会更新动作记录本身。
   * 刻意**没有** memories / proposals 字段：世界事件不产生世界事实，也不产生状态提议。
   */
  applied: { actionsUpdated: number }
}

export type WorldAdmitResult =
  | { ok: true; action: WorldActionView }
  | { ok: false; code: WorldAdmitErrorCode; reasons: string[] }

/* ==========================================================================
 * 协议限制（第一阶段）
 * ========================================================================== */

export const WORLD_LIMITS = {
  /** 单个动作 args 序列化上限（字节） */
  MAX_ARGS_BYTES: 2048,
  /** args 嵌套深度上限 */
  MAX_ARGS_DEPTH: 3,
  MAX_REASON_CHARS: 200,
  MAX_EXPECTATION_CHARS: 200,
  MAX_EVIDENCE_ITEMS: 8,
  MAX_EVIDENCE_CHARS: 128,
  MAX_EVENT_ID_CHARS: 128,
  MAX_INSTANCE_ID_CHARS: 128,
  MAX_ACTION_ID_CHARS: 128,
  MAX_SUMMARY_CHARS: 200,
  MAX_FACTS: 32,
  MAX_FACT_KEY_CHARS: 64,
  MAX_FACT_VALUE_CHARS: 200,
  MAX_CODE_CHARS: 64,
  /** 每批最多回执条数 */
  MAX_EVENTS_PER_BATCH: 50,
  /** 单次领取最多动作数 */
  MAX_LEASE_LIMIT: 8,
  DEFAULT_LEASE_LIMIT: 4,
} as const
