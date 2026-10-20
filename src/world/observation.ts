/**
 * 世界回执 → 角色认知（V0.3 第二阶段）。
 *
 * 两条纪律：
 * 1. **只有 `succeeded` 才算"已完成"**。`failed` / `rejected` 是已确认的失败，
 *    `expired` 分清"从未派发（确定没发生）"与"派发过但回执丢了（可能已发生）"。
 * 2. 进 system 块的只有**结构性**描述（动作 id、动词、目标、结果码、世界时间）。
 *    世界回执里的自由文本 `summary` 留在 `WorldEventContext` 里，供调用方或
 *    将来的数据区使用，绝不拼进系统指令区。
 *
 * 本文件是纯函数，不引用 Runtime / 存储。
 */

import type {
  WorldActionNarration,
  WorldActionStatus,
  WorldEventContext,
  WorldObservation,
} from '../types.ts'
import type { WorldActionView } from './contracts.ts'
import { narrationFor, isTerminalStatus } from './state.ts'

function toObservation(action: WorldActionView): WorldObservation {
  return {
    actionId: action.actionId,
    verb: action.verb,
    target: action.target,
    status: action.status,
    narration: action.narration,
    atWorldTimeMs: action.outcome?.atWorldTimeMs ?? null,
    summary: action.outcome?.summary ?? null,
    code: action.outcome?.code ?? null,
  }
}

/**
 * `expired` 要按"有没有派发过"分开看：
 * - 没派发过 → 世界不可能执行 → 已确认的「没发生」
 * - 派发过   → 可能已执行，只是回执丢了 → 未确认
 */
function isConfirmedUnknown(action: WorldActionView): boolean {
  if (action.status === 'expired') return narrationFor(action) === 'failed'
  return false
}

/**
 * 从动作列表构造上下文。只取最近 `limit` 条（按创建时间升序）。
 *
 * @param actions 该实例的动作视图（`WorldService.list({ instanceId })`）
 */
export function buildWorldEventContext(
  actions: readonly WorldActionView[],
  limit = 5,
): WorldEventContext {
  const recent = [...actions]
    .sort((a, b) => a.createdAtSim - b.createdAtSim || (a.actionId < b.actionId ? -1 : 1))
    .slice(-limit)

  const confirmed: WorldObservation[] = []
  const unconfirmed: WorldObservation[] = []

  for (const action of recent) {
    const observation = toObservation(action)
    if (action.status === 'succeeded') {
      confirmed.push(observation)
      continue
    }
    if (action.status === 'failed' || action.status === 'rejected') {
      confirmed.push(observation)
      continue
    }
    if (isConfirmedUnknown(action)) {
      confirmed.push(observation)
      continue
    }
    // pending / dispatched / 派发过但回执丢失的 expired
    unconfirmed.push(observation)
  }

  return { source: 'in-process', persistent: false, confirmed, unconfirmed }
}

function describeAction(o: WorldObservation): string {
  return `${o.verb}(${o.target ?? '*'})`
}

/** 已确认结果的结构性描述（不含世界自由文本）。 */
function confirmedLine(o: WorldObservation): string {
  const at = o.atWorldTimeMs === null ? '' : `（世界时间 ${o.atWorldTimeMs}）`
  switch (o.status) {
    case 'succeeded':
      return `${describeAction(o)} 成功${at}`
    case 'failed':
      return `${describeAction(o)} 失败${o.code ? `（${o.code}）` : ''}${at}`
    case 'rejected':
      return `${describeAction(o)} 被世界拒绝${o.code ? `（${o.code}）` : ''}${at}`
    case 'expired':
      return `${describeAction(o)} 没有发生${at}`
    default:
      return `${describeAction(o)} 已确认${at}`
  }
}

/** 未确认动作的结构性描述；刻意不使用"完成/成功"字样。 */
function unconfirmedLine(o: WorldObservation): string {
  if (o.status === 'pending') return `${describeAction(o)} 已提出，世界还没领取`
  if (o.status === 'dispatched') return `${describeAction(o)} 已交给世界，结果未知`
  return `${describeAction(o)} 可能已经执行，但回执丢失了，结果未知`
}

/**
 * 渲染成提示词用的两行列表。
 *
 * 只有 `succeeded` 会落到 `confirmed` 里的"成功"，其余全部是
 * 失败 / 拒绝 / 未发生 / 结果未知 —— 模型没有任何可用来声称完成的依据。
 */
export function worldContextLines(context: WorldEventContext): {
  confirmed: string[]
  unconfirmed: string[]
} {
  return {
    confirmed: context.confirmed.map(confirmedLine),
    unconfirmed: context.unconfirmed.map(unconfirmedLine),
  }
}

/** 动作是否已进入终局（供调用方判断是否需要继续轮询）。 */
export function isSettledStatus(status: WorldActionStatus): boolean {
  return isTerminalStatus(status)
}

/** 便捷：某条观察允许的叙述许可。 */
export function observationNarration(o: WorldObservation): WorldActionNarration {
  return o.narration
}
