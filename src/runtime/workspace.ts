/**
 * Runtime · 陪伴角色工作区（建在六语义内核 AgentCore 之上）
 *
 * V0.5 起，状态存储、提议—裁决、记忆写入与六个语义槽都在 `src/kernel/agent.ts`。
 * 这里只保留**陪伴扩展**自己的规则：关系里程碑、用户边界、约定（落在内核的承诺账本）、
 * 虚构时间线、对话决策与主动消息。
 *
 * 工作区是唯一有权修改「角色状态」的地方。它把四件东西组装在一起：
 *   角色设定（只读） + 动态状态 + 关系状态 + 虚构时间线
 * 并对外只提供两类操作：
 *   1. 提交提议（submitProposals）—— 由 Policy 裁决，通过的才落地；
 *   2. 推进时间（advanceTo）—— 确定性触发到期事件，不调用任何模型。
 *
 * 关键不变量：
 * - 聊天层没有关系/人格写权限，关系只能由 recordMilestone 依据可追溯事件推进；
 * - 时间推进是幂等的：同一时刻的事件只会触发一次；
 * - 所有落地与拒绝都进审计日志，可直接用于复盘。
 */

import type {
  BehaviorDecision,
  CharacterProfile,
  CharacterVoice,
  Commitment,
  MemoryKind,
  MemoryEntry,
  MessageSignals,
  Milestone,
  MilestoneKind,
  ProactiveIntent,
  RelationshipState,
  CharacterDynamicState,
  StateProposal,
  TimelineEvent,
  EpistemicStatus,
} from '../types.ts'
import type { Clock } from '../kernel/util/clock.ts'
import { DAY, HOUR } from '../kernel/util/clock.ts'
import type { IdFactory } from '../kernel/util/ids.ts'
import type { Rng } from '../kernel/util/rng.ts'
import type { SnapshotSection, SnapshotStore } from '../kernel/storage/snapshot.ts'
import type { AuditLog } from '../kernel/policy/audit.ts'
import { RUNTIME_ACTOR } from '../kernel/policy/policy.ts'
import type { PolicyEngine } from '../kernel/policy/policy.ts'
import { AgentCore } from '../kernel/agent.ts'
import type { KernelRuntimeState, ProposalOutcome, StateAppliedEvent } from '../kernel/agent.ts'
import type { DriveProfile } from '../kernel/semantics/drives.ts'
import type { Integrity } from '../kernel/integrity/index.ts'
import { Timeline } from './timeline.ts'
import { deriveStage, milestoneDelta } from '../kernel/state.ts'
import { decideForEvent, decideForIdle, decideForMessage } from './decision.ts'
import type { DecisionContext } from './decision.ts'
import { isAcceptance } from './signals.ts'

export type { ProposalOutcome } from '../kernel/agent.ts'

/** Affordance：陪伴角色在对话里可以采取的行动（与 ActionKind 一一对应）。 */
const CONVERSATION_AFFORDANCES = [
  { verb: 'respond', label: '回应', description: '正常回应对方' },
  { verb: 'negotiate', label: '协商', description: '不同意但愿意商量' },
  { verb: 'decline', label: '拒绝', description: '明确拒绝' },
  { verb: 'wait', label: '等待', description: '暂时不回应或推迟' },
  { verb: 'proactive_contact', label: '主动联系', description: '在对方没说话时主动开口' },
] as const

export interface PendingMessage {
  id: string
  intent: ProactiveIntent
  content: string
  createdAtSim: number
  status: 'pending' | 'delivered' | 'cancelled'
  /** 默认永远为 false：V0.1 不向任何外部平台推送 */
  externallyDispatched: boolean
}

/** V0.1 的约定记录；现在就是内核承诺账本里的一条承诺。 */
export type TrackedPromise = Commitment

/**
 * 状态变更旁路监听：持久层用它把每次落地写成可重放的事件。
 * 工作区不依赖 SQLite，只发通知。
 */
export interface StateSink {
  onStateApplied?(evt: {
    source: string
    proposals: StateProposal[]
    sim: number
    relationshipTouched: boolean
    /** 时间线发生变化时附带完整时间线，保证事件重放能精确还原 */
    timeline?: TimelineEvent[]
  }): void
  onEventFired?(evt: { event: TimelineEvent; timeline: TimelineEvent[] }): void
}

export interface WorkspaceOptions {
  profile: CharacterProfile
  voice: CharacterVoice
  clock: Clock
  ids: IdFactory
  rng: Rng
  snapshot: SnapshotStore
  audit?: AuditLog
  policy?: PolicyEngine
  stateSink?: StateSink
  /** 内驱力规格（V0.4 自主运行）；陪伴场景可省略 */
  drives?: DriveProfile | null
  /** 完整性层（V0.6 · 宪法 K1–K6）；不传则不记账本 */
  integrity?: Integrity | null
}

/** 可序列化的完整工作区状态，用于 SQLite 快照与事件重放校验。 */
export interface WorkspaceStateDump {
  relationship: RelationshipState
  dynamic: CharacterDynamicState
  timeline: TimelineEvent[]
  runtime: unknown
  episodic: MemoryEntry[]
  user: MemoryEntry[]
}

export interface AdvanceOutcome {
  fromSim: number
  toSim: number
  fired: TimelineEvent[]
  decisions: BehaviorDecision[]
  queued: PendingMessage[]
  idleDecision: BehaviorDecision | null
}

export interface WorkspaceView {
  character: { id: string; name: string }
  dynamic: CharacterDynamicState
  relationship: RelationshipState
  derivedStage: string
  memory: { episodic: number; user: number; total: number; deleted: number }
  timeline: { total: number; pending: number; fired: number }
  pendingMessages: number
  promises: TrackedPromise[]
}

export class CharacterWorkspace extends AgentCore implements SnapshotSection {
  readonly sectionName = 'runtime'
  readonly timeline: Timeline

  #voice: CharacterVoice
  #sink: StateSink | null

  #pendingMessages: PendingMessage[] = []
  #lastUserMessageSim: number | null = null
  #turnCount = 0
  /** 已为哪个静默期记过「边界被尊重」，避免同一个边界被反复计分 */
  #boundaryRespectRecordedFor: number | null = null
  /** 上次随事件落库的时间线版本，避免每条补丁都重复写整条时间线 */
  #sinkTimelineVersion = -1

  constructor(opts: WorkspaceOptions) {
    super({
      profile: opts.profile,
      clock: opts.clock,
      ids: opts.ids,
      rng: opts.rng,
      snapshot: opts.snapshot,
      audit: opts.audit,
      policy: opts.policy,
      drives: opts.drives ?? null,
      integrity: opts.integrity ?? null,
    })
    this.#voice = opts.voice
    this.#sink = opts.stateSink ?? null
    this.timeline = new Timeline(opts.clock, opts.ids)
    // 内核已注册 memory；按 V0.1 的顺序继续注册 timeline 与 runtime，旧快照可直接恢复
    this.snapshot.register(this.timeline).register(this)

    // Affordance：对话渠道的可行动作（陪伴扩展登记）
    this.affordance.register('conversation', () =>
      CONVERSATION_AFFORDANCES.map((a) => ({ ...a, channel: 'conversation', target: null, believedAvailable: true })),
    )
  }

  /** 打开工作区：存在快照则恢复，否则以初始状态启动。 */
  static open(opts: WorkspaceOptions): { workspace: CharacterWorkspace; restored: boolean } {
    const workspace = new CharacterWorkspace(opts)
    const meta = opts.snapshot.load()
    if (!meta) return { workspace, restored: false }
    // 恢复模拟时间：重启后时间线从上次保存处继续，而不是从头开始。
    if (typeof opts.clock.setSim === 'function' && meta.savedAtSim > opts.clock.nowSim()) {
      opts.clock.setSim(meta.savedAtSim)
    }
    return { workspace, restored: true }
  }

  /** 挂载/替换持久层旁路监听（SQLite 恢复流程会用到）。 */
  setStateSink(sink: StateSink | null): void {
    this.#sink = sink
  }

  /** 内核钩子：提议落地后通知持久层；时间线有变化时附带完整时间线。 */
  protected override afterApplied(evt: StateAppliedEvent): void {
    const timelineChanged = this.#sinkTimelineVersion !== this.timeline.version
    if (timelineChanged) this.#sinkTimelineVersion = this.timeline.version
    this.#sink?.onStateApplied?.({ ...evt, timeline: timelineChanged ? this.timeline.list() : undefined })
  }

  /**
   * 导出可序列化状态。
   * 注意：这是**状态**，不是人格；人格永远来自 Template，不会出现在这里。
   */
  dumpState(): WorkspaceStateDump {
    const all = this.memory.list({ includeDeleted: true })
    return {
      relationship: this.relationship,
      dynamic: this.dynamicState,
      timeline: this.timeline.list(),
      runtime: this.toJSON(),
      episodic: all.filter((e) => e.kind === 'episodic'),
      user: all.filter((e) => e.kind === 'user'),
    }
  }

  /** 从持久化状态恢复（Template 已由调用方校验）。 */
  restoreState(state: {
    relationship?: RelationshipState
    dynamic?: CharacterDynamicState
    timeline?: TimelineEvent[]
    runtime?: unknown
    episodic?: MemoryEntry[]
    user?: MemoryEntry[]
  }): void {
    if (state.episodic || state.user || state.relationship || state.dynamic) {
      this.memory.fromJSON({
        episodic: state.episodic ?? [],
        user: state.user ?? [],
        dynamicState: state.dynamic,
        relationship: state.relationship,
      })
    }
    if (state.timeline) this.timeline.fromJSON(state.timeline)
    if (state.runtime !== undefined && state.runtime !== null) this.fromJSON(state.runtime)
  }

  /* ------------------------------------------------------------------ 读取 */

  view(): WorkspaceView {
    const episodic = this.memory.list({ kinds: ['episodic'], includeDeleted: true })
    const user = this.memory.list({ kinds: ['user'], includeDeleted: true })
    const all = [...episodic, ...user]
    const fired = this.timeline.list().filter((e) => e.fired).length
    return {
      character: { id: this.profile.id, name: this.profile.name },
      dynamic: this.dynamicState,
      relationship: this.relationship,
      derivedStage: deriveStage(this.relationship),
      memory: {
        episodic: episodic.filter((e) => e.deletedAtSim === null).length,
        user: user.filter((e) => e.deletedAtSim === null).length,
        total: all.filter((e) => e.deletedAtSim === null).length,
        deleted: all.filter((e) => e.deletedAtSim !== null).length,
      },
      timeline: { total: this.timeline.size, pending: this.timeline.size - fired, fired },
      pendingMessages: this.#pendingMessages.filter((m) => m.status === 'pending').length,
      promises: this.motivation.commitments(),
    }
  }

  pendingMessages(): PendingMessage[] {
    return this.#pendingMessages.filter((m) => m.status === 'pending').map((m) => ({ ...m }))
  }

  /** 取出待发送消息并标记为「已交付到聊天界面」——依然不推送外部平台。 */
  drainPendingMessages(): PendingMessage[] {
    const out = this.#pendingMessages.filter((m) => m.status === 'pending')
    for (const m of out) m.status = 'delivered'
    return out.map((m) => ({ ...m }))
  }

  /* ---------------------------------------------------------------- 决策 */

  decide(signals: MessageSignals): BehaviorDecision {
    const decision = decideForMessage(signals, this.#decisionContext())
    if (decision.action === 'wait' && signals.declaredBoundary === 'do_not_disturb') {
      // 等待动作必须落到状态上，否则时间线推进时无法体现「静默期」。
      this.submitProposals(
        [
          {
            id: this.ids.next('pr'),
            target: 'dynamic',
            op: 'set',
            path: 'doNotDisturbUntilSim',
            value: this.clock.nowSim() + 6 * HOUR,
            reason: '用户表示暂时不想被打扰，进入 6 小时静默期',
            evidence: ['user_boundary'],
          },
        ],
        RUNTIME_ACTOR,
      )
    }
    return decision
  }

  behaviorContext(): DecisionContext {
    return this.#decisionContext()
  }

  #decisionContext(): DecisionContext {
    return {
      profile: this.profile,
      dynamic: this.dynamicState,
      relationship: this.relationship,
      nowSim: this.clock.nowSim(),
      voice: this.#voice,
      rng: this.rng,
    }
  }

  /* -------------------------------------------------------- 里程碑与边界 */

  /**
   * 记录一个关系里程碑，并据其类型推进关系。
   * 这是关系数值唯一合法的增长路径 —— 聊天内容无法调用到它。
   */
  recordMilestone(
    kind: MilestoneKind,
    title: string,
    evidence: string,
  ): { milestone: Milestone | null; outcome: ProposalOutcome } {
    const atSim = this.clock.nowSim()
    const milestone: Milestone = {
      id: this.ids.next('ms'),
      title,
      kind,
      atSim,
      evidence,
    }
    const delta = milestoneDelta(kind)

    const outcome = this.submitProposals(
      [
        {
          id: this.ids.next('pr'),
          target: 'relationship',
          op: 'append',
          path: 'milestones',
          value: [milestone],
          reason: `新增里程碑：${title}`,
          evidence: [evidence],
        },
        {
          id: this.ids.next('pr'),
          target: 'relationship',
          op: 'increment',
          path: 'familiarity',
          value: delta.familiarity,
          reason: `里程碑 ${kind} 带来的熟悉度变化`,
          evidence: [milestone.id],
        },
        {
          id: this.ids.next('pr'),
          target: 'relationship',
          op: 'increment',
          path: 'trust',
          value: delta.trust,
          reason: `里程碑 ${kind} 带来的信任变化`,
          evidence: [milestone.id],
        },
      ],
      RUNTIME_ACTOR,
      { source: `milestone:${kind}` },
    )

    const appended = outcome.applied.some((p) => p.path === 'milestones')
    if (!appended) {
      this.audit.append('proposal_rejected', RUNTIME_ACTOR.id, `里程碑 ${kind} 未被记录`, {
        rejected: outcome.rejected.map((r) => r.decision.code),
      })
      return { milestone: null, outcome }
    }

    // 阶段是派生值：满足条件才推进，并带里程碑证据。
    const nextStage = deriveStage(this.relationship)
    if (nextStage !== this.relationship.stage) {
      this.submitProposals(
        [
          {
            id: this.ids.next('pr'),
            target: 'relationship',
            op: 'set',
            path: 'stage',
            value: nextStage,
            reason: `依据里程碑推进关系阶段：${this.relationship.stage} -> ${nextStage}`,
            evidence: [milestone.id],
          },
        ],
        RUNTIME_ACTOR,
        { source: 'stage-derivation' },
      )
    }

    this.writeMemory(
      {
        kind: 'episodic',
        title: `里程碑：${title}`,
        content: `${title}（${kind}）：${evidence}`,
        status: 'fact',
        origin: 'runtime_event',
        salience: 0.85,
        tags: ['milestone', kind],
      },
      RUNTIME_ACTOR,
      milestone.id,
    )

    return { milestone, outcome }
  }

  /** 记录用户声明的边界（例如「暂时不要打扰我」）。 */
  declareUserBoundary(
    statement: string,
    kind: 'do_not_disturb' | 'no_contact' = 'do_not_disturb',
  ): void {
    const now = this.clock.nowSim()
    const boundary = {
      id: this.ids.next('bnd'),
      statement,
      kind: 'user_request' as const,
      sinceSim: now,
      active: true,
    }
    this.submitProposals(
      [
        {
          id: this.ids.next('pr'),
          target: 'relationship',
          op: 'append',
          path: 'boundaries',
          value: [boundary],
          reason: '用户声明了一条互动边界',
          evidence: ['user_request'],
        },
      ],
      RUNTIME_ACTOR,
      { source: 'user_boundary' },
    )
    const until = kind === 'no_contact' ? now + 30 * DAY : now + 6 * HOUR
    this.submitProposals(
      [
        {
          id: this.ids.next('pr'),
          target: 'dynamic',
          op: 'set',
          path: 'doNotDisturbUntilSim',
          value: until,
          reason: kind === 'no_contact' ? '用户要求不要再联系' : '用户要求暂时不要打扰',
          evidence: ['user_boundary'],
        },
      ],
      RUNTIME_ACTOR,
      { source: 'user_boundary' },
    )
    this.audit.append('boundary_declared', 'runtime', statement, { kind, untilSim: until })
    this.writeMemory(
      {
        kind: 'user',
        title: '用户声明的互动边界',
        content: statement,
        status: 'fact',
        origin: 'user_message',
        confirmed: true,
        salience: 0.95,
        tags: ['boundary', kind],
      },
      RUNTIME_ACTOR,
      'user_boundary',
    )
  }

  /* ------------------------------------------------ 一轮对话的运行时观察 */

  /**
   * 一轮对话结束后，运行时依据「可追溯的信号」决定是否产生里程碑。
   * 注意这里没有任何「说了几句就加好感」的逻辑。
   */
  observeTurn(signals: MessageSignals, userText: string, turnId: string): void {
    const now = this.clock.nowSim()
    const previousLastMessage = this.#lastUserMessageSim
    this.#lastUserMessageSim = now
    this.#turnCount++

    if (signals.declaredBoundary) {
      this.declareUserBoundary(userText, signals.declaredBoundary)
    }

    if (signals.promiseText) {
      const dueAtSim = now + parseDueOffsetDays(userText) * DAY
      const promise: TrackedPromise = {
        id: this.ids.next('prom'),
        text: userText,
        madeAtSim: now,
        dueAtSim,
        status: 'open',
      }
      this.motivation.add(promise)
      this.timeline.schedule({
        atSim: dueAtSim - 2 * HOUR,
        kind: 'reminder',
        title: '约定提醒',
        description: `约定的时间快到了：${promise.text}`,
        payload: { proactiveIntent: 'promise_reminder', promiseId: promise.id },
        order: 20,
      })
      this.timeline.schedule({
        atSim: dueAtSim + 12 * HOUR,
        kind: 'consequence',
        title: '约定到期未兑现',
        description: '如果用户没有出现，角色需要面对这个落空',
        payload: { promiseTimeout: promise.id },
        order: 30,
      })
      this.writeMemory(
        {
          kind: 'episodic',
          title: '一个约定',
          content: promise.text,
          status: 'fact',
          origin: 'user_message',
          salience: 0.9,
          tags: ['promise'],
        },
        RUNTIME_ACTOR,
        turnId,
      )
      this.audit.append('decision', 'runtime', '记录约定并排入时间线', {
        promiseId: promise.id,
        dueAtSim,
      })
    }

    // 分歧修复：此前有过越界，而这一轮用户表现出理解
    if (isAcceptance(userText) && this.relationship.boundaryViolations > 0) {
      this.recordMilestone('conflict_repaired', '一次分歧被认真修复', userText.slice(0, 80))
    }

    // 边界被尊重：静默期结束后用户才回来，且没有在静默期内施压。
    // 同一个静默期只记一次，否则每轮对话都会重复加分。
    const dnd = this.dynamicState.doNotDisturbUntilSim
    if (
      dnd !== null &&
      now > dnd &&
      previousLastMessage !== null &&
      this.#boundaryRespectRecordedFor !== dnd
    ) {
      this.#boundaryRespectRecordedFor = dnd
      this.recordMilestone('boundary_respected', '用户尊重了「暂时不要打扰」的边界', '静默期内没有继续施压')
    }
  }

  /** 用户越界的明确记录（例如在被拒绝后反复推进同一请求）。 */
  noteBoundaryViolation(reason: string): void {
    this.submitProposals(
      [
        {
          id: this.ids.next('pr'),
          target: 'relationship',
          op: 'increment',
          path: 'boundaryViolations',
          value: 1,
          reason: `用户越界：${reason}`,
          evidence: [reason],
        },
        {
          id: this.ids.next('pr'),
          target: 'relationship',
          op: 'increment',
          path: 'trust',
          value: -2,
          reason: '越界带来信任下降',
          evidence: [reason],
        },
      ],
      RUNTIME_ACTOR,
      { source: 'boundary_violation' },
    )
  }

  /* ------------------------------------------------------------ 时间推进 */

  /**
   * 推进模拟时间到 targetSim。
   *
   * 不调用模型：每个到期事件只会修改确定性状态、写记忆、并在需要时生成
   * 一条**待发送**消息。这就是「模拟时间推进不需要连续调用模型」的实现。
   */
  advanceTo(targetSim: number): AdvanceOutcome {
    const fromSim = this.clock.nowSim()
    if (targetSim < fromSim) {
      throw new RangeError(`模拟时间不可倒退：${fromSim} -> ${targetSim}`)
    }

    const fired: TimelineEvent[] = []
    const decisions: BehaviorDecision[] = []
    const queued: PendingMessage[] = []

    let guard = 0
    for (;;) {
      const due = this.timeline.due(targetSim)
      const next = due[0]
      if (!next) break
      if (++guard > 1000) throw new Error('事件推进超过 1000 次，疑似事件自激循环')

      this.#moveClockTo(Math.max(fromSim, next.atSim))
      this.timeline.markFired(next.id, next.atSim)
      fired.push(next)
      this.#applyEventEffects(next)

      const decision = decideForEvent(next, this.#decisionContext())
      if (decision) {
        decisions.push(decision)
        this.audit.append('decision', 'runtime', `事件决策：${decision.action}`, {
          eventId: next.id,
          rationale: decision.rationale,
        })
        if (decision.action === 'proactive_contact' && decision.proactiveMessage) {
          queued.push(
            this.queueProactive(decision.proactiveIntent ?? 'life_update', decision.proactiveMessage),
          )
        }
      }
    }

    this.#moveClockTo(targetSim)

    // 静态推进结束后，再做一次「空闲决策」：用户离开很久时角色是否开口。
    const last = this.#lastUserMessageSim ?? fromSim
    const idle = decideForIdle(this.#decisionContext(), {
      idleSinceMs: this.clock.nowSim() - last,
      pendingProactiveCount: this.pendingMessages().length,
    })
    if (idle?.action === 'proactive_contact' && idle.proactiveMessage) {
      queued.push(this.queueProactive(idle.proactiveIntent ?? 'idle_check_in', idle.proactiveMessage))
    }

    return { fromSim, toSim: targetSim, fired, decisions, queued, idleDecision: idle }
  }

  advanceBy(ms: number): AdvanceOutcome {
    return this.advanceTo(this.clock.nowSim() + ms)
  }

  #moveClockTo(sim: number): void {
    if (sim <= this.clock.nowSim()) return
    if (typeof this.clock.setSim === 'function') this.clock.setSim(sim)
  }

  #applyEventEffects(event: TimelineEvent): void {
    const p = event.payload
    const proposals: StateProposal[] = []

    const push = (path: string, value: unknown, reason: string): void => {
      proposals.push({
        id: this.ids.next('pr'),
        target: 'dynamic',
        op: 'set',
        path,
        value,
        reason,
        evidence: [event.id],
      })
    }

    if (typeof p.activity === 'string') push('activity.label', p.activity, `事件「${event.title}」改变了活动`)
    if (typeof p.moodLabel === 'string') push('mood.label', p.moodLabel, `事件「${event.title}」改变了心情`)
    if (typeof p.moodValence === 'number') push('mood.valence', p.moodValence, '事件的情绪影响')
    if (typeof p.energy === 'number') push('energy', p.energy, '事件的精力影响')
    if (p.doNotDisturbUntilSim !== undefined) {
      push('doNotDisturbUntilSim', p.doNotDisturbUntilSim, '事件的静默期设置')
    }

    if (proposals.length > 0) {
      this.submitProposals(proposals, RUNTIME_ACTOR, { source: `event:${event.id}` })
    }

    const milestone = p.milestone as { kind: MilestoneKind; title: string; evidence: string } | undefined
    if (milestone) this.recordMilestone(milestone.kind, milestone.title, milestone.evidence)

    const memory = p.memory as
      | { title: string; content: string; status?: EpistemicStatus; salience?: number; tags?: string[]; kind?: MemoryKind }
      | undefined
    if (memory) {
      this.writeMemory(
        {
          kind: memory.kind ?? 'episodic',
          title: memory.title,
          content: memory.content,
          status: memory.status ?? 'fact',
          origin: 'runtime_event',
          salience: memory.salience ?? 0.6,
          tags: memory.tags ?? [],
        },
        RUNTIME_ACTOR,
        event.id,
      )
    }

    if (typeof p.promiseTimeout === 'string') {
      this.#handlePromiseTimeout(p.promiseTimeout)
    }

    this.audit.append('event_fired', 'runtime', `事件触发：${event.title}`, {
      eventId: event.id,
      atSim: event.atSim,
      kind: event.kind,
    })
    this.#sink?.onEventFired?.({ event, timeline: this.timeline.list() })
  }

  #handlePromiseTimeout(promiseId: string): void {
    const promise = this.motivation.get(promiseId)
    if (!promise || !this.motivation.settle(promiseId, 'broken')) return
    this.recordMilestone('promise_broken', '一个约定没有被兑现', promise.text.slice(0, 80))
    this.writeMemory(
      {
        kind: 'episodic',
        title: '落空的约定',
        content: promise.text,
        status: 'fact',
        origin: 'runtime_event',
        salience: 0.8,
        tags: ['promise', 'broken'],
      },
      RUNTIME_ACTOR,
      promise.id,
    )
    this.audit.append('decision', 'runtime', '约定到期未兑现，已记为负向里程碑', {
      promiseId,
      dueAtSim: promise.dueAtSim,
    })
  }

  /** 用户确实履行了约定。 */
  fulfillPromise(promiseId: string): void {
    const promise = this.motivation.get(promiseId)
    if (!promise || !this.motivation.settle(promiseId, 'kept')) return
    this.recordMilestone('promise_kept', '用户兑现了一个约定', promise.text.slice(0, 80))
  }

  openPromises(): TrackedPromise[] {
    return this.motivation.open()
  }

  queueProactive(intent: ProactiveIntent, content: string): PendingMessage {
    const message: PendingMessage = {
      id: this.ids.next('msg'),
      intent,
      content,
      createdAtSim: this.clock.nowSim(),
      status: 'pending',
      externallyDispatched: false,
    }
    this.#pendingMessages.push(message)
    this.audit.append('decision', 'runtime', '生成待发送的主动消息（默认不外发）', {
      messageId: message.id,
      intent,
      content,
    })
    return { ...message }
  }

  /* ------------------------------------------------------------ 持久化 */

  toJSON(): unknown {
    const kernel: KernelRuntimeState = this.kernelRuntimeState()
    return {
      pendingMessages: this.#pendingMessages,
      promises: kernel.promises,
      relationshipWrites: kernel.relationshipWrites,
      lastUserMessageSim: this.#lastUserMessageSim,
      turnCount: this.#turnCount,
      boundaryRespectRecordedFor: this.#boundaryRespectRecordedFor,
    }
  }

  fromJSON(value: unknown): void {
    const v = value as {
      pendingMessages?: PendingMessage[]
      promises?: TrackedPromise[]
      relationshipWrites?: number[]
      lastUserMessageSim?: number | null
      turnCount?: number
      boundaryRespectRecordedFor?: number | null
    }
    if (!v || typeof v !== 'object') throw new Error('runtime section 结构非法')
    this.#pendingMessages = (v.pendingMessages ?? []).map((m) => ({ ...m }))
    this.restoreKernelRuntime({ promises: v.promises ?? [], relationshipWrites: v.relationshipWrites ?? [] })
    this.#lastUserMessageSim = v.lastUserMessageSim ?? null
    this.#turnCount = v.turnCount ?? 0
    this.#boundaryRespectRecordedFor = v.boundaryRespectRecordedFor ?? null
  }

}

/** 从「明天 / 后天 / 周日 / 下次」里估计约定落在几天后。 */
export function parseDueOffsetDays(text: string): number {
  if (/(今天|今晚)/.test(text)) return 0.5
  if (/明天/.test(text)) return 1
  if (/后天/.test(text)) return 2
  if (/(周日|周末|星期天)/.test(text)) return 3
  if (/下次/.test(text)) return 3
  return 2
}
