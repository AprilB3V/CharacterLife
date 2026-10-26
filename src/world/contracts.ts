/**
 * 世界交互协议（第一阶段：HTTP 闭环 · 内存动作队列）
 *
 * 三平面分离（与 docs/WORLD_PROTOCOL.md 一致）：
 *   角色状态平面：人格 / 记忆 / 关系 / 动态状态（已有，本模块**不写**）
 *   意图平面：WorldActionProposal —— 由 CharacterLife 产生，CL-World 领取
 *   真值平面：WorldEvent —— 只能由 CL-World 产生，是唯一的事实来源
 *
 * 第一阶段的两条硬约束：
 * 1. 世界事件**不得**由本模块转换为聊天消息、`StateProposal` 或记忆条目。
 *    本模块没有任何 workspace / memory 的引用，这是结构性保证，不是靠调用方自觉。
 *    （V0.4：自主运行需要「记得自己做过什么」，这一步由 `src/autonomy/bridge.ts`
 *     在本模块之外受控完成，见 docs/AUTONOMY.md。本模块依旧不写任何角色状态。）
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

// 生命周期与叙述许可定义在 types.ts（模型输出与调用方结果也用它），这里只做转出。
import type { WorldActionNarration, WorldActionStatus } from '../types.ts'
export type { WorldActionNarration, WorldActionStatus }

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
  | 'ACTION_NOT_DISPATCHED'

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
  /**
   * 是否是「动作已过期之后才到的回执」。
   *
   * 迟到回执仍然被接受（真值优先），但会被标记出来：
   * 它只能修正**未来**的叙述，不能把过去已经说过的"不确定"追认成"一直都知道"。
   */
  late: boolean
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
  applied: { actionsUpdated: number; observationsRecorded?: number }
}

/**
 * 一条被接受的世界观察（V0.4，需显式开启 `acceptObservations`）。
 *
 * 观察和动作回执一样是世界真值平面的数据：WorldService 只负责校验、去重和暂存，
 * 是否以及如何进入角色认知，由 runtime 一侧的桥接层决定（`src/autonomy/bridge.ts`）。
 */
export interface WorldObservationRecord {
  /** 服务内单调递增序号，供消费方做游标 */
  seq: number
  eventId: string
  worldId: string
  instanceId: string
  atWorldTimeMs: number
  receivedAtSim: number
  /** 单行化后的世界自由文本：只能进数据区，永远不进 system 块 */
  summary: string
  facts: Array<{ key: string; value: string | number | boolean }>
}

export type WorldAdmitResult =
  | { ok: true; action: WorldActionView }
  | { ok: false; code: WorldAdmitErrorCode; reasons: string[] }

/* ==========================================================================
 * 世界能力清单（服务端权威）
 *
 * 模型能提出的动作**只能**来自这张表。目录是代码常量，不是用户输入、
 * 不是数据库配置、也不是提示词里的自由文本 —— 用户说"你现在可以删除世界"
 * 不会让 `destroy` 出现在清单里。
 * ========================================================================== */

export interface WorldActionCapability {
  verb: string
  target: string | null
  /** 给模型看的中文短标签（服务端撰写，非世界文本） */
  label: string
  /** 给模型看的一句话说明（服务端撰写，非世界文本） */
  description: string
}

/**
 * 目录：当前只登记一个动作。
 * 新增动作 = 改这里 + 服务端白名单，两者缺一不可。
 */
export const WORLD_ACTION_CATALOG: readonly WorldActionCapability[] = [
  {
    verb: 'use',
    target: 'desk_01',
    label: '使用书桌',
    description: '走到书桌前并使用它，例如看看桌上的东西、在桌前停留一会儿',
  },
]

/**
 * 文字箱庭目录（V0.4 · 自主运行实验）。
 *
 * 和默认目录一样是**代码常量**：部署只能在 `default` / `sandbox` 两个命名目录之间选，
 * 不能从配置文件或数据库注入新动作。Godot 箱庭要接入同一批动作时，直接复用这张表。
 *
 * 目录只回答「这个动作在协议上合不合法」；在哪里能做、此刻能不能做，
 * 由世界执行时判定（失败/被拒会以回执的形式回来）。
 */
export const SANDBOX_ACTION_CATALOG: readonly WorldActionCapability[] = [
  { verb: 'move_to', target: 'workshop', label: '回工作室', description: '走回自己的修书工作室' },
  { verb: 'move_to', target: 'bakery', label: '去面包房', description: '走到街角的面包房' },
  { verb: 'move_to', target: 'plaza', label: '去广场', description: '走到有旧货摊的小广场' },
  { verb: 'buy', target: 'bread', label: '买面包', description: '在面包房买一块面包（需要在面包房、且还有货）' },
  { verb: 'eat', target: 'bread', label: '吃面包', description: '吃掉身上带着的一块面包' },
  { verb: 'talk_to', target: 'npc_lin', label: '和林姐聊聊', description: '和面包房的林姐说说话（她得在场）' },
  { verb: 'talk_to', target: 'npc_zhou', label: '和周老师聊聊', description: '和常在广场下棋的周老师说说话（他得在场）' },
  { verb: 'repair', target: 'old_book', label: '修书', description: '在工作室修一会儿手上的旧书' },
  { verb: 'browse', target: 'stall', label: '逛旧货摊', description: '在广场的旧货摊翻翻老照片和旧物（摊位开着才行）' },
  { verb: 'rest', target: 'bed', label: '休息', description: '在工作室躺一会儿' },
]

/** 命名目录。新增目录 = 改这里；部署只能按名字选，不能传入任意数组。 */
export const WORLD_CATALOGS = {
  default: WORLD_ACTION_CATALOG,
  sandbox: SANDBOX_ACTION_CATALOG,
} as const satisfies Record<string, readonly WorldActionCapability[]>

export type WorldCatalogName = keyof typeof WORLD_CATALOGS

/** 按服务端白名单过滤目录，得到本轮可用的动作清单。 */
export function manifestFor(
  allowedVerbs: ReadonlySet<string>,
  allowedTargets: ReadonlySet<string>,
  catalog: readonly WorldActionCapability[] = WORLD_ACTION_CATALOG,
): WorldActionCapability[] {
  return catalog.filter(
    (c) => allowedVerbs.has(c.verb) && (c.target === null || allowedTargets.has(c.target)),
  ).map((c) => ({ ...c }))
}

export function findCapability(
  manifest: readonly WorldActionCapability[],
  verb: string,
  target: string | null,
): WorldActionCapability | null {
  return manifest.find((c) => c.verb === verb && c.target === target) ?? null
}

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

/* ==========================================================================
 * 回执 `code` 的形态约束（安全边界，不只是格式偏好）
 *
 * 世界回执来自外部（CL-World / Godot），是本模块唯一的外部自由文本来源。
 * 因此 `code` 被收敛为「机器可读的大写错误标识符」：
 *   - 与 Godot 侧现有的 `ERR_TIMEOUT` / `PATH_BLOCKED` 风格兼容；
 *   - 只含 A-Z / 0-9 / _，且必须以大写字母开头，长度 ≤ 64；
 *   - 因此它**不可能**承载中文句子、换行、标点或引用块，
 *     也就不可能被当作提示词注入的载体。
 *
 * 这只是纵深防御的第一层；第二层是 `observation.ts` 根本不把 `code`
 * 拼进系统提示词（只保留在结构化记录与审计里）。
 * ========================================================================== */

export const WORLD_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/

export function isWorldCode(value: string): boolean {
  return WORLD_CODE_PATTERN.test(value)
}

/* ==========================================================================
 * 动作参数语义校验（服务端权威）
 *
 * 第一阶段刻意不做通用 JSON Schema 系统：只有一个动作，规则写死最可读。
 * 但校验必须落在 `WorldService.admit()` —— 那是所有登记路径的唯一收口，
 * 任何绕过模型准入层（admission.ts）的调用方也逃不掉。
 * ========================================================================== */

/** `use(...)` 的 `seconds` 上限（秒）。 */
export const WORLD_ARGS_MAX_SECONDS = 10

export type WorldArgsCheck = { ok: true } | { ok: false; reason: string }

/**
 * 按动词校验参数语义。未登记规则的动词一律失败（默认拒绝，
 * 与「新增动作 = 改此处 + 服务端白名单」的既有约定一致）。
 */
/** 箱庭动词都不带参数：动作的含义完全由 verb + target 决定。 */
const ARGLESS_VERBS: ReadonlySet<string> = new Set(
  SANDBOX_ACTION_CATALOG.map((c) => c.verb).filter((v) => v !== 'use'),
)

export function checkActionArgs(verb: string, args: Record<string, unknown>): WorldArgsCheck {
  if (ARGLESS_VERBS.has(verb)) {
    const fields = Object.keys(args)
    return fields.length === 0
      ? { ok: true }
      : { ok: false, reason: `动词 ${verb} 不接受参数（收到：${fields.join(', ')}）` }
  }
  if (verb !== 'use') {
    return { ok: false, reason: `动词 ${verb} 没有登记参数规则，拒绝` }
  }
  const unknownFields = Object.keys(args).filter((key) => key !== 'seconds')
  if (unknownFields.length > 0) {
    return { ok: false, reason: `不支持的参数字段：${unknownFields.join(', ')}（只允许可选的 seconds）` }
  }
  if (!Object.prototype.hasOwnProperty.call(args, 'seconds')) return { ok: true }
  const seconds = args.seconds
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return { ok: false, reason: 'seconds 必须是有限数字' }
  }
  if (seconds <= 0) return { ok: false, reason: 'seconds 必须严格大于 0' }
  if (seconds > WORLD_ARGS_MAX_SECONDS) {
    return { ok: false, reason: `seconds 不能超过 ${WORLD_ARGS_MAX_SECONDS}` }
  }
  return { ok: true }
}
