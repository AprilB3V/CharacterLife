/**
 * WorldService —— 世界动作的内存队列与回执处理（第一阶段）。
 *
 * 边界（必须保持）：
 * - 不认识 `CharacterWorkspace`、不认识 `MemoryStore`、不产生 `StateProposal`；
 * - 只维护动作记录与事件去重键；
 * - 所有时间判定使用 `clock.nowSim()`（模拟时间），不使用 `Date.now()`；
 * - `worldId` / `instanceId` 由服务端解析并绑定，**不接受调用方指定**。
 *
 * 非持久化：`#actions`、`#eventKeys`、`#admitLog` 全在内存。
 * 进程重启 → 未结算动作与去重键全部丢失。这是第一阶段的已知限制，
 * 正式持久化（崩溃一致性 + 迁移 + 租约恢复）在第二阶段实现。
 */

import type { Clock } from '../util/clock.ts'
import type { IdFactory } from '../util/ids.ts'
import type {
  WorldActionRecord,
  WorldActionResult,
  WorldActionSpec,
  WorldActionStatus,
  WorldActionView,
  WorldAdmitErrorCode,
  WorldAdmitResult,
  WorldEvent,
  WorldIngestErrorCode,
  WorldIngestResult,
} from './contracts.ts'
import { WORLD_LIMITS, WORLD_RESULTS } from './contracts.ts'
import { isTerminalStatus, narrationFor } from './state.ts'

export interface WorldServiceOptions {
  clock: Clock
  ids: IdFactory
  /** 服务端权威的实例归属查询：instanceId → 该实例所属世界（不存在返回 null） */
  lookupInstance: (instanceId: string) => { worldId: string } | null
  /** 授权世界白名单；为空表示世界交互未启用 */
  worldIds?: readonly string[]
  /** 动词白名单；第一阶段只允许 use */
  allowedVerbs?: readonly string[]
  /** 目标白名单；第一阶段只允许 desk_01 */
  allowedTargets?: readonly string[]
  /** 动作从登记到被领取的最长等待（模拟时间毫秒） */
  actionTtlSim?: number
  /** 一次领取的租约时长（模拟时间毫秒） */
  leaseTtlSim?: number
  /** 最多领取次数；超出仍无回执即 expired */
  maxAttempts?: number
  /** 每实例每模拟小时的准入上限 */
  maxActionsPerSimHour?: number
}

/** 事件校验结果：失败时尽量带回 eventId，便于逐条报告。 */
type ValidatedEvent =
  | { ok: true; event: WorldEvent }
  | { ok: false; eventId: string; code: WorldIngestErrorCode; message: string }

const ACTION_ID_CHARS = /^[A-Za-z0-9_\-:.]{1,128}$/
const EVENT_ID_CHARS = /^[A-Za-z0-9_\-:.]{1,128}$/

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function depthOf(value: unknown, depth = 0): number {
  if (depth > WORLD_LIMITS.MAX_ARGS_DEPTH) return depth
  if (Array.isArray(value)) {
    return value.reduce<number>((max, item) => Math.max(max, depthOf(item, depth + 1)), depth)
  }
  if (isPlainObject(value)) {
    return Object.values(value).reduce<number>((max, item) => Math.max(max, depthOf(item, depth + 1)), depth)
  }
  return depth
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

/** 单行化：世界文本会原样回显到 HTTP 与日志，先压掉换行，避免日志/终端注入。 */
function singleLine(text: string): string {
  return text.replace(/[\r\n\t]+/g, ' ').trim()
}

function isResult(value: unknown): value is WorldActionResult {
  return typeof value === 'string' && (WORLD_RESULTS as readonly string[]).includes(value)
}

function fail(eventId: string, code: WorldIngestErrorCode, message: string): ValidatedEvent {
  return { ok: false, eventId, code, message }
}

/**
 * 校验一条世界回执。**这一步不做任何副作用**，只判断结构。
 * 顺序：结构 → 枚举 → 长度，任何一步失败都返回 MALFORMED（除 eventId 长度用 MALFORMED）。
 */
export function validateWorldEvent(raw: unknown): ValidatedEvent {
  if (!isPlainObject(raw)) return fail('', 'MALFORMED', '事件必须是对象')

  const rawEventId = raw.eventId
  if (typeof rawEventId !== 'string' || !EVENT_ID_CHARS.test(rawEventId)) {
    return fail(
      typeof rawEventId === 'string' ? rawEventId.slice(0, 64) : '',
      'MALFORMED',
      `eventId 必须是 1..${WORLD_LIMITS.MAX_EVENT_ID_CHARS} 位 [A-Za-z0-9_-:.] 字符`,
    )
  }
  const eventId = rawEventId

  if (
    raw.worldId !== undefined &&
    raw.worldId !== null &&
    typeof raw.worldId !== 'string'
  ) {
    return fail(eventId, 'MALFORMED', 'worldId 必须是字符串')
  }
  if (
    typeof raw.instanceId !== 'string' ||
    raw.instanceId.length === 0 ||
    raw.instanceId.length > WORLD_LIMITS.MAX_INSTANCE_ID_CHARS
  ) {
    return fail(eventId, 'MALFORMED', 'instanceId 缺失或过长')
  }
  if (raw.actionId !== null && raw.actionId !== undefined) {
    if (typeof raw.actionId !== 'string' || !ACTION_ID_CHARS.test(raw.actionId)) {
      return fail(eventId, 'MALFORMED', 'actionId 非法')
    }
  }
  if (typeof raw.kind !== 'string' || !(raw.kind === 'action_result' || raw.kind === 'observation')) {
    return fail(eventId, 'MALFORMED', 'kind 必须是 action_result 或 observation')
  }
  if (raw.kind === 'action_result') {
    if (!isResult(raw.result)) {
      return fail(eventId, 'MALFORMED', `result 必须是 ${WORLD_RESULTS.join(' / ')}`)
    }
  } else if (raw.result !== null && raw.result !== undefined) {
    return fail(eventId, 'MALFORMED', 'observation 事件的 result 必须为 null')
  }
  if (typeof raw.atWorldTimeMs !== 'number' || !Number.isFinite(raw.atWorldTimeMs) || raw.atWorldTimeMs < 0) {
    return fail(eventId, 'MALFORMED', 'atWorldTimeMs 必须是非负数')
  }
  if (typeof raw.summary !== 'string') {
    return fail(eventId, 'MALFORMED', 'summary 必须是字符串')
  }
  if (raw.summary.length > WORLD_LIMITS.MAX_SUMMARY_CHARS) {
    return fail(eventId, 'MALFORMED', `summary 超过 ${WORLD_LIMITS.MAX_SUMMARY_CHARS} 字符`)
  }
  if (raw.code !== null && raw.code !== undefined) {
    if (typeof raw.code !== 'string' || raw.code.length > WORLD_LIMITS.MAX_CODE_CHARS) {
      return fail(eventId, 'MALFORMED', 'code 非法')
    }
  }

  const facts: WorldEvent['facts'] = []
  if (raw.facts !== undefined && raw.facts !== null) {
    if (!Array.isArray(raw.facts)) return fail(eventId, 'MALFORMED', 'facts 必须是数组')
    if (raw.facts.length > WORLD_LIMITS.MAX_FACTS) {
      return fail(eventId, 'MALFORMED', `facts 超过 ${WORLD_LIMITS.MAX_FACTS} 条`)
    }
    for (const item of raw.facts) {
      if (!isPlainObject(item)) return fail(eventId, 'MALFORMED', 'facts 条目必须是对象')
      if (typeof item.key !== 'string' || item.key.length === 0 || item.key.length > WORLD_LIMITS.MAX_FACT_KEY_CHARS) {
        return fail(eventId, 'MALFORMED', 'facts.key 非法')
      }
      if (!isScalar(item.value)) return fail(eventId, 'MALFORMED', 'facts.value 必须是字符串/数字/布尔')
      if (typeof item.value === 'string' && item.value.length > WORLD_LIMITS.MAX_FACT_VALUE_CHARS) {
        return fail(eventId, 'MALFORMED', 'facts.value 过长')
      }
      facts.push({ key: item.key, value: item.value })
    }
  }

  return {
    ok: true,
    event: {
      eventId,
      worldId: typeof raw.worldId === 'string' ? raw.worldId : null,
      instanceId: raw.instanceId,
      actionId: typeof raw.actionId === 'string' ? raw.actionId : null,
      kind: raw.kind,
      result: raw.kind === 'action_result' ? (raw.result as WorldActionResult) : null,
      atWorldTimeMs: raw.atWorldTimeMs,
      summary: singleLine(raw.summary),
      facts,
      code: typeof raw.code === 'string' ? raw.code : null,
    },
  }
}

export class WorldService {
  #clock: Clock
  #ids: IdFactory
  #lookupInstance: (instanceId: string) => { worldId: string } | null
  #worldIds: ReadonlySet<string>
  #allowedVerbs: ReadonlySet<string>
  #allowedTargets: ReadonlySet<string>
  #actionTtlSim: number
  #leaseTtlSim: number
  #maxAttempts: number
  #maxActionsPerSimHour: number

  #actions = new Map<string, WorldActionRecord>()
  /** 事件去重键：`${worldId}\u0000${eventId}` */
  #eventKeys = new Map<string, { actionId: string | null; receivedAtSim: number }>()
  /** 准入限速：instanceId → 准入时刻（模拟时间） */
  #admitLog = new Map<string, number[]>()

  constructor(opts: WorldServiceOptions) {
    this.#clock = opts.clock
    this.#ids = opts.ids
    this.#lookupInstance = opts.lookupInstance
    this.#worldIds = new Set(opts.worldIds ?? [])
    this.#allowedVerbs = new Set(opts.allowedVerbs ?? [])
    this.#allowedTargets = new Set(opts.allowedTargets ?? [])
    this.#actionTtlSim = opts.actionTtlSim ?? 90_000
    this.#leaseTtlSim = opts.leaseTtlSim ?? 30_000
    this.#maxAttempts = opts.maxAttempts ?? 2
    this.#maxActionsPerSimHour = opts.maxActionsPerSimHour ?? 120
  }

  /** 未配置任何世界 → 整条链路惰性，HTTP 路由也不会挂载。 */
  get enabled(): boolean {
    return this.#worldIds.size > 0
  }

  /** 第一阶段恒为 false，供健康检查与文档明示。 */
  get persistent(): boolean {
    return false
  }

  get worldIds(): string[] {
    return [...this.#worldIds]
  }

  get allowedVerbs(): string[] {
    return [...this.#allowedVerbs]
  }

  get allowedTargets(): string[] {
    return [...this.#allowedTargets]
  }

  nowSim(): number {
    return this.#clock.nowSim()
  }

  /** 该 worldId 是否被服务端授权（token 之外的第二道校验）。 */
  authorizesWorld(worldId: string): boolean {
    return this.#worldIds.has(worldId)
  }

  /* ------------------------------------------------------------------ 准入 */

  /**
   * 登记一个世界动作。
   *
   * 调用方给的是「意图」；`worldId` / `instanceId` 由服务端解析并复核：
   * - 实例必须存在；
   * - 实例所属世界必须等于请求世界；
   * 两者任一不成立都直接拒绝，绝不"按调用方说的来"。
   */
  admit(input: { worldId: string; instanceId: string; spec: WorldActionSpec }): WorldAdmitResult {
    const now = this.#clock.nowSim()
    this.expireStale(now)

    if (!this.enabled) {
      return { ok: false, code: 'WORLD_DISABLED', reasons: ['世界交互未启用（未配置 worldIds）'] }
    }
    if (!this.authorizesWorld(input.worldId)) {
      return { ok: false, code: 'WORLD_NOT_BOUND', reasons: [`worldId ${input.worldId} 未被本服务授权`] }
    }

    const instance = this.#lookupInstance(input.instanceId)
    if (!instance) {
      return { ok: false, code: 'INSTANCE_NOT_FOUND', reasons: [`实例 ${input.instanceId} 不存在`] }
    }
    if (instance.worldId !== input.worldId) {
      return {
        ok: false,
        code: 'INSTANCE_WORLD_MISMATCH',
        reasons: [`实例 ${input.instanceId} 属于 ${instance.worldId}，不能向 ${input.worldId} 发动作`],
      }
    }

    const spec = input.spec
    if (!this.#allowedVerbs.has(spec.verb)) {
      return {
        ok: false,
        code: 'VERB_NOT_ALLOWED',
        reasons: [`verb=${spec.verb} 不在白名单 [${[...this.#allowedVerbs].join(', ')}] 内`],
      }
    }
    if (spec.target !== null && !this.#allowedTargets.has(spec.target)) {
      return {
        ok: false,
        code: 'TARGET_NOT_ALLOWED',
        reasons: [`target=${spec.target} 不在白名单 [${[...this.#allowedTargets].join(', ')}] 内`],
      }
    }

    const argsCheck = checkArgs(spec.args)
    if (argsCheck) return { ok: false, code: argsCheck.code, reasons: [argsCheck.message] }

    if (this.#admittedRecently(input.instanceId, now) >= this.#maxActionsPerSimHour) {
      return {
        ok: false,
        code: 'RATE_LIMITED',
        reasons: [`实例 ${input.instanceId} 在本模拟小时内已达准入上限 ${this.#maxActionsPerSimHour}`],
      }
    }

    const correlationId = `${input.instanceId}:${spec.turnId ?? 'op'}:${this.#ids.next('corr')}`
    for (const existing of this.#actions.values()) {
      if (existing.correlationId === correlationId && !isTerminalStatus(existing.status)) {
        return { ok: false, code: 'DUPLICATE_INTENT', reasons: ['同一轮次已登记相同意图'] }
      }
    }

    const record: WorldActionRecord = {
      id: this.#ids.next('wa'),
      worldId: input.worldId,
      instanceId: input.instanceId,
      verb: spec.verb,
      target: spec.target,
      args: structuredClone(spec.args),
      reason: spec.reason.slice(0, WORLD_LIMITS.MAX_REASON_CHARS),
      evidence: spec.evidence.slice(0, WORLD_LIMITS.MAX_EVIDENCE_ITEMS).map((e) => e.slice(0, WORLD_LIMITS.MAX_EVIDENCE_CHARS)),
      expectation: spec.expectation === null ? null : spec.expectation.slice(0, WORLD_LIMITS.MAX_EXPECTATION_CHARS),
      status: 'pending',
      correlationId,
      turnId: spec.turnId,
      createdAtSim: now,
      expiresAtSim: now + this.#actionTtlSim,
      firstDispatchedAtSim: null,
      leaseExpiresAtSim: null,
      attempts: 0,
      maxAttempts: this.#maxAttempts,
      outcome: null,
    }
    this.#actions.set(record.id, record)
    const log = this.#admitLog.get(input.instanceId)
    if (log) log.push(now)
    else this.#admitLog.set(input.instanceId, [now])

    return { ok: true, action: this.view(record) }
  }

  /* ------------------------------------------------------------------ 领取 */

  /**
   * 世界领取待执行动作（幂等窗口内）。
   * 只有 `pending` 且未过截止时刻的动作会被返回，返回即进入 `dispatched`。
   */
  lease(worldId: string, limit: number): WorldActionView[] {
    const now = this.#clock.nowSim()
    this.expireStale(now)
    if (!this.authorizesWorld(worldId)) return []

    const leaseTtl = this.#leaseTtlSim
    const candidates = [...this.#actions.values()]
      .filter((a) => a.worldId === worldId && a.status === 'pending' && now < a.expiresAtSim)
      .sort((a, b) => (a.createdAtSim - b.createdAtSim) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

    const out: WorldActionView[] = []
    for (const action of candidates) {
      if (out.length >= limit) break
      action.status = 'dispatched'
      action.attempts += 1
      if (action.firstDispatchedAtSim === null) action.firstDispatchedAtSim = now
      action.leaseExpiresAtSim = now + leaseTtl
      // 截止时刻随租约顺延：一个有效租约不能被原始 TTL 提前掐断。
      action.expiresAtSim = action.leaseExpiresAtSim
      out.push(this.view(action))
    }
    return out
  }

  /* ------------------------------------------------------------------ 回执 */

  /**
   * 处理一批世界回执。
   *
   * 逐条独立判定，单条失败不影响同批其它事件（否则重试会重复处理已成功的条目）。
   * 去重优先级：同 eventId = duplicate（幂等），同 actionId 二次结算 = rejected。
   *
   * **副作用范围**：只改动作记录。不写记忆、不写状态、不产生聊天消息。
   */
  ingest(worldId: string, events: readonly unknown[]): WorldIngestResult {
    const now = this.#clock.nowSim()
    this.expireStale(now)

    const result: WorldIngestResult = {
      accepted: [],
      duplicates: [],
      rejected: [],
      applied: { actionsUpdated: 0 },
    }

    for (const raw of events) {
      const validated = validateWorldEvent(raw)
      if (!validated.ok) {
        result.rejected.push({ eventId: validated.eventId, code: validated.code, message: validated.message })
        continue
      }
      const event = validated.event

      // 1) 世界归属：显式声明时只做一致性校验；实际归属永远取请求级（token 授权过的）worldId
      if (event.worldId !== null && event.worldId !== worldId) {
        result.rejected.push({
          eventId: event.eventId,
          code: 'WORLD_MISMATCH',
          message: `事件声明 worldId=${event.worldId}，与请求世界 ${worldId} 不一致`,
        })
        continue
      }

      // 2) eventId 去重（先于任何副作用）
      const key = `${worldId}\u0000${event.eventId}`
      if (this.#eventKeys.has(key)) {
        result.duplicates.push(event.eventId)
        continue
      }

      // 3) 第一阶段只处理动作结果；观测事件留到第二阶段
      if (event.kind !== 'action_result') {
        result.rejected.push({
          eventId: event.eventId,
          code: 'UNSUPPORTED_KIND',
          message: '第一阶段只接受 kind=action_result',
        })
        continue
      }
      if (event.actionId === null || event.result === null) {
        result.rejected.push({
          eventId: event.eventId,
          code: 'MALFORMED',
          message: 'action_result 必须带 actionId 与 result',
        })
        continue
      }

      // 4) 实例归属：实例必须存在且确实属于该世界
      const instance = this.#lookupInstance(event.instanceId)
      if (!instance) {
        result.rejected.push({
          eventId: event.eventId,
          code: 'UNKNOWN_INSTANCE',
          message: `实例 ${event.instanceId} 不存在`,
        })
        continue
      }
      if (instance.worldId !== worldId) {
        result.rejected.push({
          eventId: event.eventId,
          code: 'INSTANCE_WORLD_MISMATCH',
          message: `实例 ${event.instanceId} 属于 ${instance.worldId}，与事件世界 ${worldId} 不一致`,
        })
        continue
      }

      // 5) actionId 去重 + 归属复核
      const action = this.#actions.get(event.actionId)
      if (!action) {
        result.rejected.push({
          eventId: event.eventId,
          code: 'UNKNOWN_ACTION',
          message: `动作 ${event.actionId} 不存在（第一阶段队列仅存于内存）`,
        })
        continue
      }
      if (action.worldId !== worldId) {
        result.rejected.push({
          eventId: event.eventId,
          code: 'WORLD_MISMATCH',
          message: `动作 ${event.actionId} 属于 ${action.worldId}`,
        })
        continue
      }
      if (action.instanceId !== event.instanceId) {
        result.rejected.push({
          eventId: event.eventId,
          code: 'ACTION_INSTANCE_MISMATCH',
          message: `动作 ${event.actionId} 属于实例 ${action.instanceId}`,
        })
        continue
      }
      if (isTerminalStatus(action.status)) {
        result.rejected.push({
          eventId: event.eventId,
          code: 'ACTION_ALREADY_SETTLED',
          message: `动作 ${event.actionId} 已结算为 ${action.status}`,
        })
        continue
      }

      // 6) 接受：先落去重键，再改动作（第二阶段会放进同一事务）
      this.#eventKeys.set(key, { actionId: action.id, receivedAtSim: now })
      action.status = event.result
      action.leaseExpiresAtSim = null
      action.outcome = {
        eventId: event.eventId,
        result: event.result,
        code: event.code,
        summary: event.summary,
        atWorldTimeMs: event.atWorldTimeMs,
        receivedAtSim: now,
      }
      result.accepted.push(event.eventId)
      result.applied.actionsUpdated += 1
    }

    return result
  }

  /* ------------------------------------------------------------------ 过期 */

  /**
   * 惰性过期：只在 lease / ingest / admit / 查询时调用。
   * 刻意**不引入定时器**，保证同一时钟输入必然得到同一结果。
   */
  expireStale(nowSim: number = this.#clock.nowSim()): number {
    let expired = 0
    for (const action of this.#actions.values()) {
      if (action.status === 'pending' && nowSim >= action.expiresAtSim) {
        action.status = 'expired'
        expired += 1
        continue
      }
      if (action.status === 'dispatched' && nowSim >= action.expiresAtSim) {
        if (action.attempts < action.maxAttempts) {
          // 还有重试预算：回到 pending，并给一个与租约等长的窗口
          action.status = 'pending'
          action.leaseExpiresAtSim = null
          action.expiresAtSim = nowSim + this.#leaseTtlSim
        } else {
          action.status = 'expired'
          expired += 1
        }
      }
    }
    return expired
  }

  /* ------------------------------------------------------------------ 读取 */

  get(actionId: string): WorldActionView | null {
    const action = this.#actions.get(actionId)
    return action ? this.view(action) : null
  }

  list(filter: { worldId?: string; instanceId?: string; status?: WorldActionStatus } = {}): WorldActionView[] {
    return [...this.#actions.values()]
      .filter((a) => (filter.worldId ? a.worldId === filter.worldId : true))
      .filter((a) => (filter.instanceId ? a.instanceId === filter.instanceId : true))
      .filter((a) => (filter.status ? a.status === filter.status : true))
      .sort((a, b) => (a.createdAtSim - b.createdAtSim) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((a) => this.view(a))
  }

  counts(): Record<WorldActionStatus, number> {
    const counts: Record<WorldActionStatus, number> = {
      pending: 0,
      dispatched: 0,
      succeeded: 0,
      failed: 0,
      rejected: 0,
      expired: 0,
    }
    for (const action of this.#actions.values()) counts[action.status] += 1
    return counts
  }

  eventCount(): number {
    return this.#eventKeys.size
  }

  view(action: WorldActionRecord): WorldActionView {
    return {
      actionId: action.id,
      correlationId: action.correlationId,
      instanceId: action.instanceId,
      worldId: action.worldId,
      verb: action.verb,
      target: action.target,
      args: structuredClone(action.args),
      expectation: action.expectation,
      status: action.status,
      narration: narrationFor(action),
      attempts: action.attempts,
      maxAttempts: action.maxAttempts,
      createdAtSim: action.createdAtSim,
      expiresAtSim: action.expiresAtSim,
      firstDispatchedAtSim: action.firstDispatchedAtSim,
      leaseExpiresAtSim: action.leaseExpiresAtSim,
      outcome: action.outcome ? { ...action.outcome } : null,
    }
  }

  #admittedRecently(instanceId: string, nowSim: number): number {
    const log = this.#admitLog.get(instanceId) ?? []
    const since = nowSim - 3_600_000
    const recent = log.filter((t) => t >= since)
    this.#admitLog.set(instanceId, recent)
    return recent.length
  }
}

function checkArgs(args: unknown): { code: WorldAdmitErrorCode; message: string } | null {
  if (!isPlainObject(args)) return { code: 'ARGS_INVALID', message: 'args 必须是普通对象' }
  if (depthOf(args) > WORLD_LIMITS.MAX_ARGS_DEPTH) {
    return { code: 'ARGS_INVALID', message: `args 嵌套超过 ${WORLD_LIMITS.MAX_ARGS_DEPTH} 层` }
  }
  let serialized: string
  try {
    serialized = JSON.stringify(args)
  } catch {
    return { code: 'ARGS_INVALID', message: 'args 不能序列化为 JSON' }
  }
  if (serialized === undefined) return { code: 'ARGS_INVALID', message: 'args 不能序列化为 JSON' }
  if (Buffer.byteLength(serialized, 'utf8') > WORLD_LIMITS.MAX_ARGS_BYTES) {
    return { code: 'ARGS_TOO_LARGE', message: `args 序列化超过 ${WORLD_LIMITS.MAX_ARGS_BYTES} 字节` }
  }
  return null
}
