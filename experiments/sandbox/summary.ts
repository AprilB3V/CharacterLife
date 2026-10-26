/**
 * 箱庭运行的汇总指标（纯函数）。
 *
 * H5 的核心度量：从某个参考时刻起（干预组 = 干预时刻；对照 = 同一时刻），
 *   - 第一次尝试社交（talk_to）要等多久；
 *   - 2 小时窗口内登记了几个社交动作。
 * 同一种子的「干预 vs 不干预」只差一个驱力值，所以差异可以归因于那一个驱力。
 */

import type { AutonomyLogRecord } from '../../src/kernel/cycle/runner.ts'
import type { TruthRecord } from './world.ts'

export interface SandboxSummary {
  wakes: number
  admitted: number
  gateRejected: number
  noAction: number
  mindErrors: number
  outcomes: Record<string, number>
  actions: Record<string, number>
  wakeReasons: Record<string, number>
  tokens: { calls: number; prompt: number; completion: number }
  drivePeak: Record<string, number>
  truthEvents: number
  intervention: { atSim: number; firstSocialAttemptMin: number | null; socialActionsWithin2h: number } | null
}

const SOCIAL = /^talk_to\(/

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1
}

/** 从参考时刻起的社交指标（干预组与对照组用同一个参考时刻）。 */
export function socialWindow(
  records: readonly AutonomyLogRecord[],
  fromSim: number,
  windowMs = 2 * 3_600_000,
): { firstSocialAttemptMin: number | null; socialActionsWithin2h: number } {
  let first: number | null = null
  let count = 0
  for (const r of records) {
    if (r.type !== 'wake' || r.t < fromSim || !r.action || !SOCIAL.test(r.action)) continue
    if (r.admission && !r.admission.ok) continue
    if (first === null) first = Math.round((r.t - fromSim) / 60_000)
    if (r.t < fromSim + windowMs) count += 1
  }
  return { firstSocialAttemptMin: first, socialActionsWithin2h: count }
}

export function summarize(
  records: readonly AutonomyLogRecord[],
  truth: readonly TruthRecord[],
  opts: { intervention?: { atSim: number } | null; referenceSim?: number } = {},
): SandboxSummary {
  const s: SandboxSummary = {
    wakes: 0,
    admitted: 0,
    gateRejected: 0,
    noAction: 0,
    mindErrors: 0,
    outcomes: {},
    actions: {},
    wakeReasons: {},
    tokens: { calls: 0, prompt: 0, completion: 0 },
    drivePeak: {},
    truthEvents: truth.length,
    intervention: null,
  }
  for (const r of records) {
    if (r.type === 'outcome') bump(s.outcomes, r.status)
    if (r.type !== 'wake') continue
    s.wakes += 1
    for (const reason of r.reasons) bump(s.wakeReasons, reason.kind)
    for (const [k, v] of Object.entries(r.drives)) s.drivePeak[k] = Math.max(s.drivePeak[k] ?? 0, v)
    if (r.error) s.mindErrors += 1
    if (r.usage) {
      s.tokens.calls += 1
      s.tokens.prompt += r.usage.promptTokens
      s.tokens.completion += r.usage.completionTokens
    }
    if (!r.action) {
      s.noAction += 1
      continue
    }
    if (r.admission?.ok) {
      s.admitted += 1
      bump(s.actions, r.action)
    } else {
      s.gateRejected += 1
    }
  }
  const ref = opts.intervention?.atSim ?? opts.referenceSim
  if (ref !== undefined) s.intervention = { atSim: ref, ...socialWindow(records, ref) }
  return s
}
