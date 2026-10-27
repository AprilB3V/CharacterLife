/**
 * AutonomyRunner：一个角色的自主轮次调度（V0.4）。
 *
 * 每次 `step()`：
 *   1. 桥接层同步世界结算与观察 → 情景记忆、驱力缓解、处境信念；
 *   2. 读取驱力（纯函数）；
 *   3. Waker 判断要不要醒（纯函数，不调用模型）；
 *   4. 醒了才组装六类语义交给 Mind；
 *   5. Mind 的候选走**与聊天轮次同一个**准入闸门，再进 WorldService.admit()。
 *
 * 这里不另造决策中枢：Runner 只做调度与组装，「做什么」由 Mind 提议、
 * 「能不能做」由闸门与世界决定，「状态怎么变」由 Policy 裁决。
 *
 * 所有发生的事都以 `AutonomyLogRecord` 的形式交给 logger，一行一条，
 * 同一份日志既是实验数据，也是 Godot 回放与故事素材的来源。
 */

import type { BehaviorDecision, CharacterProfile } from '../types.ts'
import { RUNTIME_ACTOR } from '../policy/policy.ts'
import type { AgentCore } from '../agent.ts'
import type { WorldService } from '../world/service.ts'
import { admitWorldIntents } from '../world/admission.ts'
import { buildWorldEventContext } from '../world/observation.ts'
import { formatSim } from '../util/clock.ts'
import type { IdFactory } from '../util/ids.ts'
import type { BridgeSync, WorldBridge } from './bridge.ts'
import type { Situation } from '../semantics/situation.ts'
import type { DriveReading } from '../semantics/drives.ts'
import { initDriveProposals, interventionProposal } from '../semantics/drives.ts'
import type { Mind, MindDecision, MindInput, MindMemory, MindRecentOutcome } from './mind.ts'
import { actionKey } from './mind.ts'
import type { WakeDecision, WakerConfig } from './waker.ts'
import { decideWake } from './waker.ts'

/** 自主轮次的「行为决策」占位：准入闸门需要一个决策，自主轮次本身不是拒绝/等待。 */
export const AUTONOMY_DECISION: BehaviorDecision = Object.freeze({
  action: 'respond',
  scores: { respond: 1, negotiate: 0, decline: 0, wait: 0, proactive_contact: 0 },
  rationale: ['自主轮次：由 Waker 唤醒，不是对用户消息的回应'],
  responseStyle: 'autonomous',
  proactiveIntent: null,
  proactiveMessage: null,
  nextActionSim: null,
}) as BehaviorDecision

export type AutonomyLogRecord =
  | {
      type: 'start'
      t: number
      clock: string
      mind: string
      condition: { useDrives: boolean; driveInputToMind: boolean }
      drives: Record<string, number>
    }
  | { type: 'outcome'; t: number; clock: string; actionId: string; action: string; status: string; epistemic: string; driveChanges: Array<{ path: string; value: unknown }> }
  | { type: 'observation'; t: number; clock: string; events: string[] }
  | {
      type: 'wake'
      t: number
      clock: string
      seq: number
      reasons: WakeDecision['reasons']
      drives: Record<string, number>
      situation: Pick<Situation, 'location' | 'present' | 'inventory'>
      memories: string[]
      mind: string
      thought: string
      action: string | null
      reason: string | null
      admission: { ok: true; actionId: string } | { ok: false; code: string; reasons: string[] } | null
      error: string | null
      usage: MindDecision['usage']
      latencyMs: number
    }
  | { type: 'intervention'; t: number; clock: string; drive: string; value: number }

export interface AutonomyRunnerOptions {
  /** 角色内核：六个语义槽都从这里读，驱力规格在 agent.motivation 上 */
  agent: AgentCore
  world: WorldService
  worldId: string
  instanceId: string
  bridge: WorldBridge
  mind: Mind
  waker: WakerConfig
  /**
   * 是否把驱力读数交给 Mind（H5 对照：A 组 false）。
   * 与 `waker.useDrives` 分开，便于做"只唤醒不告知"之类的消融。
   */
  driveInputToMind: boolean
  ids: IdFactory
  logger?: (record: AutonomyLogRecord) => void
  /** 每次唤醒检索几条记忆 */
  memoryLimit?: number
  /** 世界 id → 显示名，交给 Mind 渲染 */
  names?: Readonly<Record<string, string>>
}

const OUTCOME_TEXT: Record<string, string> = {
  succeeded: '成功',
  failed: '失败',
  rejected: '被世界拒绝',
  expired: '没有发生',
}

function driveMap(readings: readonly DriveReading[]): Record<string, number> {
  return Object.fromEntries(readings.map((r) => [r.name, r.value]))
}

export class AutonomyRunner {
  #o: AutonomyRunnerOptions
  #seq = 0
  #lastWakeSim: number | null = null
  #lastDriveWake: Record<string, number> = {}
  #recentWakes: number[] = []
  #pendingOutcomes: string[] = []
  #pendingSalient: string[] = []
  #started = false

  constructor(opts: AutonomyRunnerOptions) {
    this.#o = opts
    // Affordance：世界渠道 = 服务端动作清单，按角色的处境信念标出「此地可做」
    opts.agent.affordance.register('world', () => {
      const here = new Set(opts.agent.situation.current().affords)
      return opts.world.manifest().map((c) => ({
        channel: 'world',
        verb: c.verb,
        target: c.target,
        label: c.label,
        description: c.description,
        believedAvailable: here.has(actionKey(c.verb, c.target)),
      }))
    })
  }

  get wakes(): number {
    return this.#seq
  }

  #clock(): string {
    return formatSim(this.#o.agent.nowSim())
  }

  #log(record: AutonomyLogRecord): void {
    this.#o.logger?.(record)
  }

  /** 把驱力写成显式状态（之后的衰减都从这里算起）。只执行一次。 */
  start(): void {
    if (this.#started) return
    this.#started = true
    const profile = this.#o.agent.motivation.driveProfile
    if (profile) {
      const proposals = initDriveProposals(profile, () => this.#o.ids.next('pr'))
      this.#o.agent.submitProposals(proposals, RUNTIME_ACTOR, { source: 'autonomy_init' })
    }
    this.#log({
      type: 'start',
      t: this.#o.agent.nowSim(),
      clock: this.#clock(),
      mind: this.#o.mind.name,
      condition: { useDrives: this.#o.waker.useDrives, driveInputToMind: this.#o.driveInputToMind },
      drives: driveMap(this.readDrives()),
    })
  }

  readDrives(): DriveReading[] {
    return this.#o.agent.motivation.drives()
  }

  /** 实验干预（H5）：直接设定某条驱力。走 Runtime 提议通道，审计可见。 */
  intervene(driveName: string, value: number): boolean {
    const spec = this.#o.agent.motivation.driveProfile?.specs.find((s) => s.name === driveName)
    if (!spec) return false
    const outcome = this.#o.agent.submitProposals(
      [interventionProposal(spec, value, () => this.#o.ids.next('pr'))],
      RUNTIME_ACTOR,
      { source: 'experiment' },
    )
    const ok = outcome.applied.length === 1
    if (ok) {
      this.#log({ type: 'intervention', t: this.#o.agent.nowSim(), clock: this.#clock(), drive: driveName, value })
    }
    return ok
  }

  /** 推进一个调度步。返回本步是否唤醒了 Mind。 */
  async step(): Promise<{ woke: boolean; sync: BridgeSync; wake: WakeDecision }> {
    if (!this.#started) this.start()
    const o = this.#o
    const now = o.agent.nowSim()

    const sync = o.bridge.sync()
    for (const outcome of sync.outcomes) {
      this.#pendingOutcomes.push(outcome.actionId)
      this.#log({
        type: 'outcome',
        t: now,
        clock: this.#clock(),
        actionId: outcome.actionId,
        action: actionKey(outcome.verb, outcome.target),
        status: outcome.status,
        epistemic: outcome.epistemic,
        driveChanges: outcome.driveChanges,
      })
    }
    for (const note of sync.salient) {
      this.#pendingSalient.push(note.events.join(','))
      this.#log({ type: 'observation', t: now, clock: this.#clock(), events: note.events })
    }

    const drives = this.readDrives()
    this.#recentWakes = this.#recentWakes.filter((t) => t > now - 3_600_000)
    const wake = decideWake({
      nowSim: now,
      config: o.waker,
      drives,
      lastWakeSim: this.#lastWakeSim,
      lastDriveWakeSim: this.#lastDriveWake,
      recentWakes: this.#recentWakes,
      actionInFlight: o.bridge.actionInFlight(),
      newOutcomes: this.#pendingOutcomes,
      newSalient: this.#pendingSalient,
      dueCommitments: [],
    })
    if (!wake.wake) return { woke: false, sync, wake }

    this.#seq += 1
    this.#lastWakeSim = now
    this.#recentWakes.push(now)
    for (const r of wake.reasons) if (r.kind === 'drive') this.#lastDriveWake[r.detail] = now
    this.#pendingOutcomes = []
    this.#pendingSalient = []

    const input = this.#buildInput(now, drives, wake)
    const decision = await o.mind.decide(input)
    // K4：模型原始输出完整入账（复现 = 依据账本重放，而不是重新生成）
    if (decision.raw && o.agent.integrity) {
      o.agent.integrity.recordModelOutput(o.agent.id, {
        provider: decision.provider,
        model: decision.raw.model,
        requestFingerprint: decision.raw.requestFingerprint,
        text: decision.raw.text,
        usage: decision.usage,
      })
    }

    let admission: Extract<AutonomyLogRecord, { type: 'wake' }>['admission'] = null
    if (decision.action) {
      admission = this.#admit(decision, now)
    }

    this.#log({
      type: 'wake',
      t: now,
      clock: this.#clock(),
      seq: this.#seq,
      reasons: wake.reasons,
      drives: driveMap(drives),
      situation: {
        location: input.situation.location,
        present: input.situation.present,
        inventory: input.situation.inventory,
      },
      memories: input.memories.map((m) => m.id),
      mind: o.mind.name,
      thought: decision.thought,
      action: decision.action ? actionKey(decision.action.verb, decision.action.target) : null,
      reason: decision.action?.reason ?? null,
      admission,
      error: decision.error,
      usage: decision.usage,
      latencyMs: decision.latencyMs,
    })
    return { woke: true, sync, wake }
  }

  #admit(
    decision: MindDecision,
    now: number,
  ): { ok: true; actionId: string } | { ok: false; code: string; reasons: string[] } {
    const o = this.#o
    const action = decision.action!
    const turnId = `auto_${String(this.#seq).padStart(4, '0')}`
    const gate = admitWorldIntents({
      candidates: [
        { verb: action.verb, target: action.target, reason: action.reason, expectation: action.expectation, evidence: [`wake:${this.#seq}`] },
      ],
      decision: AUTONOMY_DECISION,
      dynamic: o.agent.dynamicState,
      manifest: o.world.manifest(),
      worldEnabled: o.world.enabled,
      nowSim: now,
      turnId,
    })
    const spec = gate.admitted[0]
    if (!spec) {
      const rejected = gate.rejected[0]
      return { ok: false, code: rejected?.code ?? 'UNKNOWN', reasons: rejected?.reasons ?? [] }
    }
    const result = o.world.admit({ worldId: o.worldId, instanceId: o.instanceId, spec })
    if (!result.ok) return { ok: false, code: result.code, reasons: result.reasons }
    // K2：登记意图（以世界动作 id 为引用键）；它只能被世界权威的一条事实结算
    o.agent.integrity?.intent(o.agent.id, result.action.actionId, {
      verb: spec.verb,
      target: spec.target,
      reason: spec.reason,
      expectation: spec.expectation,
      turnId,
    })
    o.agent.audit.append('world_action', 'autonomy', `自主轮次登记世界动作 ${actionKey(spec.verb, spec.target)}`, {
      actionId: result.action.actionId,
      turnId,
      reason: spec.reason,
    })
    return { ok: true, actionId: result.action.actionId }
  }

  #buildInput(now: number, drives: DriveReading[], wake: WakeDecision): MindInput {
    const o = this.#o
    // 六类语义各从自己的槽里取：Self / Situation / Observation(唤醒原因) / Memory / Motivation / Affordance
    const profile: Readonly<CharacterProfile> = o.agent.self.persona
    const situation = o.agent.situation.current()

    // 结构性的最近结果描述：不含世界自由文本与错误码（与 observation.ts 同一纪律）。
    // 不带世界时间戳：世界时钟的量纲由各个世界自己定义，模型只需要先后顺序。
    const ctx = buildWorldEventContext(o.world.list({ instanceId: o.instanceId }), 4)
    const settled: MindRecentOutcome[] = ctx.confirmed.map((c) => ({
      verb: c.verb,
      target: c.target,
      status: c.status,
      line: `${actionKey(c.verb, c.target)} ${OUTCOME_TEXT[c.status] ?? c.status}`,
    }))

    const urgent = drives.filter((d) => d.urgent).map((d) => d.label)
    const query = [
      situation.location ?? '',
      ...situation.present,
      ...urgent,
      ...wake.reasons.map((r) => r.detail),
    ].join(' ')
    const memories: MindMemory[] = o.agent.memory
      .search(query, { nowSim: now, limit: o.memoryLimit ?? 6 })
      .map((r) => ({
        id: r.entry.id,
        title: r.entry.title,
        content: r.entry.content,
        status: r.entry.status,
        ageMinutes: Math.max(0, Math.round((now - r.entry.createdAtSim) / 60_000)),
      }))

    return {
      nowSim: now,
      clock: this.#clock(),
      self: {
        name: profile.name,
        occupation: profile.occupation,
        traits: [...profile.traits],
        values: [...profile.values],
        interests: [...profile.interests],
        dislikes: [...profile.dislikes],
        goals: [...profile.goals],
      },
      situation,
      wakeReasons: wake.reasons,
      drives: o.driveInputToMind ? drives : null,
      memories,
      recentOutcomes: settled,
      options: o.agent.affordance.list('world').map((a) => ({
        verb: a.verb,
        target: a.target,
        label: a.label,
        description: a.description,
        believedAvailableHere: a.believedAvailable,
      })),
      ...(o.names ? { names: o.names } : {}),
    }
  }
}
