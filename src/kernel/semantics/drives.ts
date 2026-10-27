/**
 * 内驱力（V0.4 · 自主运行）
 *
 * 研究假设 H5：角色要在**无人输入**时产生自发目标，需要一个独立于语言的内源压力。
 * 这里把它做成最朴素的形式：几条随时间线性上升的「压力」，被已确认的世界结果缓解。
 *
 * 三条纪律：
 * 1. **纯函数**。当前值 = 存储水平 + 速率 × 经过时间，时间推进不写状态、不调用模型；
 * 2. **只有已确认的世界结果才能缓解驱力**。动作失败、被拒、结果未知 → 什么都不变。
 *    这是「动机有因果来源」的最低要求：角色说自己吃过了不算，世界确认才算；
 * 3. 驱力只通过 `RUNTIME_ACTOR` 的状态提议落地（Policy 要求 `state:write:drives`），
 *    每一次变化都有审计与可重放的事件。
 *
 * 驱力规格（速率、阈值、满足关系）属于**角色配置**，不属于状态：
 * 状态里只存「上次确认的水平 + 时刻」。
 */

import type { CharacterDynamicState, DriveLevel, StateProposal } from '../types.ts'
import { HOUR } from '../util/clock.ts'

export interface DriveSpec {
  /** 小写标识符，对应状态路径 `drives.<name>` */
  name: string
  /** 给模型与日志看的中文名 */
  label: string
  /** 每模拟小时上升多少（0..1 量纲） */
  risePerHour: number
  /** 超过这个值就算「迫切」，会触发唤醒 */
  wakeThreshold: number
  /** 初始水平 */
  initial: number
}

/**
 * 满足关系：某个世界动作**成功**后，对各驱力的影响（负数 = 缓解）。
 * 例：`{ verb: 'eat', target: 'bread', effects: { hunger: -0.7 } }`
 */
export interface DriveSatisfier {
  verb: string
  target: string | null
  effects: Record<string, number>
}

export interface DriveProfile {
  specs: readonly DriveSpec[]
  satisfiers: readonly DriveSatisfier[]
}

export interface DriveReading {
  name: string
  label: string
  value: number
  threshold: number
  urgent: boolean
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** 某条驱力在 `nowSim` 时刻的值（确定性）。状态里没有记录时按规格初始值、自 0 时刻起算。 */
export function driveValue(spec: DriveSpec, stored: DriveLevel | undefined, nowSim: number): number {
  const base = stored ?? { level: spec.initial, atSim: 0 }
  const elapsedHours = Math.max(0, nowSim - base.atSim) / HOUR
  return round3(clamp01(base.level + spec.risePerHour * elapsedHours))
}

export function readDrives(
  profile: DriveProfile,
  dynamic: CharacterDynamicState,
  nowSim: number,
): DriveReading[] {
  return profile.specs.map((spec) => {
    const value = driveValue(spec, dynamic.drives?.[spec.name], nowSim)
    return { name: spec.name, label: spec.label, value, threshold: spec.wakeThreshold, urgent: value >= spec.wakeThreshold }
  })
}

/** 最迫切的那条（并列时按规格顺序取第一条，保证确定性）。 */
export function mostUrgent(readings: readonly DriveReading[]): DriveReading | null {
  let best: DriveReading | null = null
  for (const r of readings) {
    if (best === null || r.value > best.value) best = r
  }
  return best
}

/** 自主运行开始时把驱力写成显式状态（之后的衰减曲线都以此为起点）。 */
export function initDriveProposals(profile: DriveProfile, makeId: () => string): StateProposal[] {
  return profile.specs.map((spec) => ({
    id: makeId(),
    target: 'dynamic',
    op: 'set',
    path: `drives.${spec.name}`,
    value: spec.initial,
    reason: `自主运行启动：驱力「${spec.label}」初始化为 ${spec.initial}`,
    evidence: ['autonomy_init'],
  }))
}

export function satisfierFor(profile: DriveProfile, verb: string, target: string | null): DriveSatisfier | null {
  return profile.satisfiers.find((s) => s.verb === verb && s.target === target) ?? null
}

/**
 * 一个**已成功**的世界动作带来的驱力变化。
 * 调用方负责只在 `succeeded` 时调用；这里不看结果，只算数。
 */
export function satisfactionProposals(input: {
  profile: DriveProfile
  dynamic: CharacterDynamicState
  verb: string
  target: string | null
  atSim: number
  evidence: string
  makeId: () => string
}): StateProposal[] {
  const satisfier = satisfierFor(input.profile, input.verb, input.target)
  if (!satisfier) return []
  const out: StateProposal[] = []
  for (const spec of input.profile.specs) {
    const delta = satisfier.effects[spec.name]
    if (delta === undefined || delta === 0) continue
    const before = driveValue(spec, input.dynamic.drives?.[spec.name], input.atSim)
    const after = round3(clamp01(before + delta))
    out.push({
      id: input.makeId(),
      target: 'dynamic',
      op: 'set',
      path: `drives.${spec.name}`,
      value: after,
      reason: `世界确认 ${input.verb}(${input.target ?? '*'}) 成功：「${spec.label}」${before} → ${after}`,
      evidence: [input.evidence],
    })
  }
  return out
}

/**
 * 实验干预：把某条驱力直接设成指定值（H5 的因果检验用）。
 * 走同一条提议通道，审计里会留下「干预」字样，不会和自然变化混淆。
 */
export function interventionProposal(spec: DriveSpec, value: number, makeId: () => string): StateProposal {
  return {
    id: makeId(),
    target: 'dynamic',
    op: 'set',
    path: `drives.${spec.name}`,
    value: clamp01(value),
    reason: `实验干预：「${spec.label}」被设为 ${clamp01(value)}`,
    evidence: ['experiment_intervention'],
  }
}
