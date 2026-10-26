/**
 * Waker：什么时候值得唤醒 Mind（确定性纯函数，不调用模型）。
 *
 * 这是对 DECISIONS.md「不做后台持续调用 LLM」的正面回应：
 * 角色不会每个 tick 都"想一想"，只在离散的、写得出原因的时刻被唤醒，
 * 每个原因都会进入日志，事后可以逐条复盘"它为什么在这时候动了"。
 *
 * 唤醒原因只有五种：
 *   drive      某条驱力越过阈值（且距离上次因它唤醒已足够久）
 *   outcome    自己的动作有了结果（成功 / 失败 / 被拒 / 没发生）
 *   salient    出现了值得注意的新观察（例如有人来了）
 *   commitment 承诺到期（E2 起使用）
 *   heartbeat  很久没醒过了，低频兜底
 *
 * 抑制条件（任一成立即不唤醒）：
 *   - 自己还有动作在执行中（结果未知时不该另起炉灶，等结果）
 *   - 距离上次唤醒不足最小间隔（outcome 例外：结果到了就该看一眼）
 *   - 本模拟小时的调用预算已用完
 */

import type { DriveReading } from './drives.ts'

export type WakeReasonKind = 'drive' | 'outcome' | 'salient' | 'commitment' | 'heartbeat'

export interface WakeReason {
  kind: WakeReasonKind
  /** 机器可读的细节，例如 drive 名、观察类型、动作 id */
  detail: string
}

export interface WakerConfig {
  /** 是否把驱力当作唤醒源（H5 对照组 A 关闭） */
  useDrives: boolean
  /** 低频心跳（模拟毫秒） */
  heartbeatMs: number
  /** 两次唤醒的最小间隔（模拟毫秒），outcome 不受限 */
  minGapMs: number
  /** 同一条驱力两次触发唤醒的最小间隔，避免"一直饿就一直醒" */
  driveRepeatMs: number
  /** 每模拟小时最多唤醒几次（= Mind 调用预算） */
  maxWakesPerHour: number
}

export interface WakerInput {
  nowSim: number
  config: WakerConfig
  drives: readonly DriveReading[]
  /** 上一次唤醒时刻；从未唤醒为 null */
  lastWakeSim: number | null
  /** 每条驱力上一次触发唤醒的时刻 */
  lastDriveWakeSim: Readonly<Record<string, number>>
  /** 最近一小时内的唤醒时刻（用于预算） */
  recentWakes: readonly number[]
  /** 自己是否有尚未结算的动作 */
  actionInFlight: boolean
  /** 自上次唤醒以来新结算的自己的动作 id */
  newOutcomes: readonly string[]
  /** 自上次唤醒以来新的显著观察（已由桥接层判定显著性） */
  newSalient: readonly string[]
  /** 已到期的承诺 id */
  dueCommitments: readonly string[]
}

export interface WakeDecision {
  wake: boolean
  reasons: WakeReason[]
  /** 不唤醒时的原因（用于日志："为什么这时候没动"同样重要） */
  suppressedBy: string | null
}

const HOUR_MS = 3_600_000

export function decideWake(input: WakerInput): WakeDecision {
  const { config, nowSim } = input

  const used = input.recentWakes.filter((t) => t > nowSim - HOUR_MS).length
  if (used >= config.maxWakesPerHour) {
    return { wake: false, reasons: [], suppressedBy: `budget(${used}/${config.maxWakesPerHour} per hour)` }
  }
  if (input.actionInFlight) {
    return { wake: false, reasons: [], suppressedBy: 'action_in_flight' }
  }

  const reasons: WakeReason[] = []
  for (const id of input.newOutcomes) reasons.push({ kind: 'outcome', detail: id })

  const sinceLast = input.lastWakeSim === null ? Number.POSITIVE_INFINITY : nowSim - input.lastWakeSim
  const gapOk = sinceLast >= config.minGapMs

  if (gapOk) {
    for (const id of input.dueCommitments) reasons.push({ kind: 'commitment', detail: id })
    for (const id of input.newSalient) reasons.push({ kind: 'salient', detail: id })
    if (config.useDrives) {
      for (const d of input.drives) {
        if (!d.urgent) continue
        const last = input.lastDriveWakeSim[d.name]
        if (last !== undefined && nowSim - last < config.driveRepeatMs) continue
        reasons.push({ kind: 'drive', detail: d.name })
      }
    }
    if (reasons.length === 0 && sinceLast >= config.heartbeatMs) {
      reasons.push({ kind: 'heartbeat', detail: input.lastWakeSim === null ? 'first' : `${Math.round(sinceLast / 60000)}min` })
    }
  }

  if (reasons.length === 0) {
    return { wake: false, reasons, suppressedBy: gapOk ? 'nothing_to_do' : 'min_gap' }
  }
  return { wake: true, reasons, suppressedBy: null }
}
