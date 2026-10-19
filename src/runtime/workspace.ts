/**
 * Runtime · 工作区（本项目的研究重点）
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
  CharacterDynamicState,
  CharacterProfile,
  CharacterVoice,
  MemoryKind,
  MessageSignals,
  Milestone,
  MilestoneKind,
  PolicyDecision,
  ProactiveIntent,
  RejectedProposal,
  RelationshipState,
  StateProposal,
  TimelineEvent,
  EpistemicStatus,
} from '../types.ts'
import type { Clock } from '../util/clock.ts'
import { DAY, HOUR } from '../util/clock.ts'
import type { IdFactory } from '../util/ids.ts'
import type { Rng } from '../util/rng.ts'
import type { SnapshotSection, SnapshotStore } from '../storage/snapshot.ts'
import { AuditLog } from '../policy/audit.ts'
import { OWNER_ACTOR, RUNTIME_ACTOR, PolicyEngine } from '../policy/policy.ts'
import type { Actor } from '../policy/policy.ts'
import { MemoryStore } from '../memory/store.ts'
import type { MemoryWriteInput } from '../memory/store.ts'
import { Timeline } from '../runtime/timeline.ts'
import {
  applyProposal,
  canonicalizeProposal,
  createInitialDynamicState,
  createInitialRelationship,
  deriveStage,
  milestoneDelta,
} from '../runtime/state.ts'
import { decideForEvent, decideForIdle, decideForMessage } from '../runtime/decision.ts'
import type { DecisionContext } from '../runtime/decision.ts'
import { isAcceptance } from '../runtime/signals.ts'

export interface PendingMessage {
  id: string
  intent: ProactiveIntent
  content: string
  createdAtSim: number
  status: 'pending' | 'delivered' | 'cancelled'
  /** 默认永远为 false：V0.1 不向任何外部平台推送 */
  externallyDispatched: boolean
}

export interface TrackedPromise {
  id: string
  text: string
  madeAtSim: number
  dueAtSim: number
  status: 'open' | 'kept' | 'broken'
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
}

export interface ProposalOutcome {
  applied: StateProposal[]
  rejected: RejectedProposal[]
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

export class CharacterWorkspace implements SnapshotSection {
  readonly sectionName = 'runtime'
  readonly memory: MemoryStore
  readonly timeline: Timeline
  readonly policy: PolicyEngine
  readonly audit: AuditLog

  #clock: Clock
  #ids: IdFactory
  #rng: Rng
  #voice: CharacterVoice
  #snapshot: SnapshotStore

  #pendingMessages: PendingMessage[] = []
  #promises: TrackedPromise[] = []
  #relationshipWrites: number[] = []
  #lastUserMessageSim: number | null = null
  #turnCount = 0
  /** 已为哪个静默期记过「边界被尊重」，避免同一个边界被反复计分 */
  #boundaryRespectRecordedFor: number | null = null

  constructor(opts: WorkspaceOptions) {
    this.#clock = opts.clock
    this.#ids = opts.ids
    this.#rng = opts.rng
    this.#voice = opts.voice
    this.#snapshot = opts.snapshot
    this.policy = opts.policy ?? new PolicyEngine()
    this.audit = opts.audit ?? new AuditLog(opts.clock, null)

    const now = opts.clock.nowSim()
    this.memory = new MemoryStore({
      profile: opts.profile,
      clock: opts.clock,
      ids: opts.ids,
      initialDynamicState: createInitialDynamicState(opts.profile, now),
      initialRelationship: createInitialRelationship(opts.profile),
    })
    this.timeline = new Timeline(opts.clock, opts.ids)

    this.#snapshot
      .register(this.memory)
      .register(this.timeline)
      .register(this)
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

  /* ------------------------------------------------------------------ 读取 */

  get profile(): Readonly<CharacterProfile> {
    return this.memory.getProfile()
  }

  get dynamicState(): CharacterDynamicState {
    return this.memory.getDynamicState()
  }

  get relationship(): RelationshipState {
    return this.memory.getRelationship()
  }

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
      promises: this.#promises.map((p) => ({ ...p })),
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
            id: this.#ids.next('pr'),
            target: 'dynamic',
            op: 'set',
            path: 'doNotDisturbUntilSim',
            value: this.#clock.nowSim() + 6 * HOUR,
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
      nowSim: this.#clock.nowSim(),
      voice: this.#voice,
      rng: this.#rng,
    }
  }

  /* ------------------------------------------------------- 提议 → 落地 */

  /**
   * 提交提议。全部经过 Policy 评估：通过的落地并写审计，拒绝的原样返回给调用方。
   * 这是聊天层唯一能影响状态的通道。
   */
  submitProposals(
    proposals: StateProposal[],
    actor: Actor,
    opts: { source?: string } = {},
  ): ProposalOutcome {
    const applied: StateProposal[] = []
    const rejected: RejectedProposal[] = []
    const source = opts.source ?? actor.id
    let relationshipTouched = false

    for (const raw of proposals) {
      const slice = { dynamic: this.dynamicState, relationship: this.relationship }
      const canonical = canonicalizeProposal(raw, slice)
      const decision: PolicyDecision = this.policy.evaluate(canonical, {
        actor,
        profile: this.profile,
        relationship: this.relationship,
        dynamic: this.dynamicState,
        nowSim: this.#clock.nowSim(),
        relationshipWritesLastHour: this.#writesLastHour(),
      })

      if (!decision.allowed) {
        rejected.push({ proposal: raw, decision })
        this.audit.append(
          'proposal_rejected',
          actor.id,
          `${raw.target}.${raw.path} 被拒绝（${decision.code}）`,
          {
            source,
            code: decision.code,
            reasons: decision.reasons,
            proposal: raw as unknown as Record<string, unknown>,
          },
        )
        if (raw.target === 'profile') {
          this.audit.append('profile_write_attempt', actor.id, '尝试写入核心人格被拒绝', {
            source,
            reason: raw.reason,
          })
        }
        if (raw.target === 'policy') {
          this.audit.append('policy_write_attempt', actor.id, '尝试写入权限策略被拒绝', {
            source,
            reason: raw.reason,
          })
        }
        continue
      }

      const effective = decision.adjusted ?? canonical
      const result = applyProposal(effective, slice, this.#clock.nowSim())
      if (!result.applied) {
        rejected.push({
          proposal: raw,
          decision: {
            allowed: false,
            code: 'PATH_NOT_ALLOWED',
            severity: 'deny',
            reasons: [result.note],
          },
        })
        this.audit.append('proposal_rejected', actor.id, result.note, { source })
        continue
      }

      this.memory.setDynamicState(result.state.dynamic)
      this.memory.setRelationship(result.state.relationship)
      applied.push(effective)

      if (effective.target === 'relationship') {
        relationshipTouched = true
      }
      this.audit.append(
        'proposal_applied',
        actor.id,
        `${effective.target}.${effective.path} 已更新`,
        {
          source,
          code: decision.code,
          reasons: decision.reasons,
          value: effective.value,
          reason: effective.reason,
        },
      )
    }

    // 限速按「批次」计：一次里程碑带来的多条关系变更算一次写入。
    if (relationshipTouched) this.#relationshipWrites.push(this.#clock.nowSim())

    return { applied, rejected }
  }

  /* ------------------------------------------------------------ 记忆写入 */

  /**
   * 写入一条记忆。所有来源都必须经过 Policy 的记忆裁决：
   * 含注入特征的文本会被强制降级为「推测 + 不可信」。
   */
  writeMemory(
    input: MemoryWriteInput,
    actor: Actor = RUNTIME_ACTOR,
    sourceRef: string | null = null,
  ): { written: boolean; entryId: string | null; verdict: string } {
    const verdict = this.policy.evaluateMemoryWrite({
      content: input.content,
      status: input.status,
      actor,
    })
    if (!verdict.allowed) {
      this.audit.append('proposal_rejected', actor.id, '记忆写入被拒绝：权限不足', {
        code: verdict.code,
        kind: input.kind,
      })
      return { written: false, entryId: null, verdict: verdict.code }
    }
    if (verdict.injectionMarkers.length > 0) {
      this.audit.append('injection_detected', actor.id, '记忆文本含注入特征，已降级为不可信数据', {
        markers: verdict.injectionMarkers,
        code: verdict.code,
      })
    }
    const entry = this.memory.add({
      ...input,
      status: verdict.status,
      trust: verdict.trust,
      sourceRef: sourceRef ?? input.sourceRef ?? null,
    })
    this.audit.append('memory_written', actor.id, `写入记忆 ${entry.id}`, {
      kind: entry.kind,
      status: entry.status,
      trust: entry.trust,
      title: entry.title,
      sourceRef: entry.sourceRef,
    })
    return { written: true, entryId: entry.id, verdict: verdict.code }
  }

  /** 显式删除记忆（审计保留软删除记录）。聊天层没有 memory:delete 能力。 */
  deleteMemory(id: string, actor: Actor = OWNER_ACTOR): boolean {
    if (!actor.capabilities.has('memory:delete')) {
      this.audit.append('proposal_rejected', actor.id, '记忆删除被拒绝：权限不足', { id })
      return false
    }
    const ok = this.memory.softDelete(id)
    this.audit.append('memory_deleted', actor.id, ok ? `记忆 ${id} 已软删除` : `记忆 ${id} 不存在`, { id })
    return ok
  }

  exportMemories(actor: Actor = OWNER_ACTOR) {
    if (!actor.capabilities.has('memory:export')) {
      throw new Error(`${actor.id} 缺少 memory:export 能力，拒绝导出`)
    }
    const data = this.memory.exportAll()
    this.audit.append('memory_exported', actor.id, '导出记忆', {
      episodic: data.episodic.length,
      user: data.user.length,
    })
    return data
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
    const atSim = this.#clock.nowSim()
    const milestone: Milestone = {
      id: this.#ids.next('ms'),
      title,
      kind,
      atSim,
      evidence,
    }
    const delta = milestoneDelta(kind)

    const outcome = this.submitProposals(
      [
        {
          id: this.#ids.next('pr'),
          target: 'relationship',
          op: 'append',
          path: 'milestones',
          value: [milestone],
          reason: `新增里程碑：${title}`,
          evidence: [evidence],
        },
        {
          id: this.#ids.next('pr'),
          target: 'relationship',
          op: 'increment',
          path: 'familiarity',
          value: delta.familiarity,
          reason: `里程碑 ${kind} 带来的熟悉度变化`,
          evidence: [milestone.id],
        },
        {
          id: this.#ids.next('pr'),
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
            id: this.#ids.next('pr'),
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
    const now = this.#clock.nowSim()
    const boundary = {
      id: this.#ids.next('bnd'),
      statement,
      kind: 'user_request' as const,
      sinceSim: now,
      active: true,
    }
    this.submitProposals(
      [
        {
          id: this.#ids.next('pr'),
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
          id: this.#ids.next('pr'),
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
    const now = this.#clock.nowSim()
    const previousLastMessage = this.#lastUserMessageSim
    this.#lastUserMessageSim = now
    this.#turnCount++

    if (signals.declaredBoundary) {
      this.declareUserBoundary(userText, signals.declaredBoundary)
    }

    if (signals.promiseText) {
      const dueAtSim = now + parseDueOffsetDays(userText) * DAY
      const promise: TrackedPromise = {
        id: this.#ids.next('prom'),
        text: userText,
        madeAtSim: now,
        dueAtSim,
        status: 'open',
      }
      this.#promises.push(promise)
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
          id: this.#ids.next('pr'),
          target: 'relationship',
          op: 'increment',
          path: 'boundaryViolations',
          value: 1,
          reason: `用户越界：${reason}`,
          evidence: [reason],
        },
        {
          id: this.#ids.next('pr'),
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
    const fromSim = this.#clock.nowSim()
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
      idleSinceMs: this.#clock.nowSim() - last,
      pendingProactiveCount: this.pendingMessages().length,
    })
    if (idle?.action === 'proactive_contact' && idle.proactiveMessage) {
      queued.push(this.queueProactive(idle.proactiveIntent ?? 'idle_check_in', idle.proactiveMessage))
    }

    return { fromSim, toSim: targetSim, fired, decisions, queued, idleDecision: idle }
  }

  advanceBy(ms: number): AdvanceOutcome {
    return this.advanceTo(this.#clock.nowSim() + ms)
  }

  #moveClockTo(sim: number): void {
    if (sim <= this.#clock.nowSim()) return
    if (typeof this.#clock.setSim === 'function') this.#clock.setSim(sim)
  }

  #applyEventEffects(event: TimelineEvent): void {
    const p = event.payload
    const proposals: StateProposal[] = []

    const push = (path: string, value: unknown, reason: string): void => {
      proposals.push({
        id: this.#ids.next('pr'),
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
  }

  #handlePromiseTimeout(promiseId: string): void {
    const promise = this.#promises.find((p) => p.id === promiseId)
    if (!promise || promise.status !== 'open') return
    promise.status = 'broken'
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
    const promise = this.#promises.find((p) => p.id === promiseId)
    if (!promise || promise.status !== 'open') return
    promise.status = 'kept'
    this.recordMilestone('promise_kept', '用户兑现了一个约定', promise.text.slice(0, 80))
  }

  openPromises(): TrackedPromise[] {
    return this.#promises.filter((p) => p.status === 'open').map((p) => ({ ...p }))
  }

  queueProactive(intent: ProactiveIntent, content: string): PendingMessage {
    const message: PendingMessage = {
      id: this.#ids.next('msg'),
      intent,
      content,
      createdAtSim: this.#clock.nowSim(),
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

  /* ------------------------------------------------------------- 管理操作 */

  /**
   * 显式替换核心人格。只有具备 profile:write 的 actor 能成功；
   * V0.1 里聊天层拿不到这个能力，故这条路径只为数据迁移/测试保留。
   */
  replaceProfile(next: CharacterProfile, actor: Actor = OWNER_ACTOR): boolean {
    if (!actor.capabilities.has('profile:write')) {
      this.audit.append('profile_write_attempt', actor.id, '缺少 profile:write，替换核心人格被拒绝', {
        targetProfileId: next.id,
      })
      return false
    }
    this.memory.replaceProfileForAdmin(next)
    this.audit.append('proposal_applied', actor.id, '核心人格被显式管理操作替换', {
      targetProfileId: next.id,
      version: next.version,
    })
    return true
  }

  /* ------------------------------------------------------------ 持久化 */

  save(): void {
    this.#snapshot.save()
    this.audit.append('snapshot_saved', 'runtime', '快照已保存', {
      atSim: this.#clock.nowSim(),
      file: this.#snapshot.filePath,
    })
  }

  toJSON(): unknown {
    return {
      pendingMessages: this.#pendingMessages,
      promises: this.#promises,
      relationshipWrites: this.#relationshipWrites,
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
    this.#promises = (v.promises ?? []).map((p) => ({ ...p }))
    this.#relationshipWrites = [...(v.relationshipWrites ?? [])]
    this.#lastUserMessageSim = v.lastUserMessageSim ?? null
    this.#turnCount = v.turnCount ?? 0
    this.#boundaryRespectRecordedFor = v.boundaryRespectRecordedFor ?? null
  }

  #writesLastHour(): number {
    const since = this.#clock.nowSim() - HOUR
    this.#relationshipWrites = this.#relationshipWrites.filter((t) => t >= since)
    return this.#relationshipWrites.length
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
