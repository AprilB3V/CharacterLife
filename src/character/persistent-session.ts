/**
 * PersistentSession —— 把「一个角色实例 + 一次聊天会话」组合起来。
 *
 * 这是跨会话连续性的落地点：
 * - 打开时执行 8 步 Rehydration（模板校验 → 快照 → 事件重放 → 记忆 → 预算 → 新会话）；
 * - 每轮对话的状态变更、记忆写入、上下文用量都写进 SQLite；
 * - 关闭只结束 Session，**不影响实例状态**，所以新会话能接着上次的人格与记忆。
 */

import type { ConversationTurnResult, LLMProvider } from '../types.ts'
import type { CharacterPersistence } from '../persistence/store.ts'
import type { CharacterDatabase } from '../persistence/database.ts'
import { CharacterPersistence as Persistence } from '../persistence/store.ts'
import type { CharacterInstance, SessionRecord, SessionEndReason } from './instance.ts'
import type { CharacterTemplate } from './template.ts'
import { CharacterRehydrator } from './rehydration.ts'
import type { RehydrationReport } from './rehydration.ts'
import type { CharacterWorkspace } from '../runtime/workspace.ts'
import { ConversationService } from '../conversation/service.ts'
import type { ContextBudget } from '../context/manager.ts'
import type { Clock } from '../kernel/util/clock.ts'
import type { SequentialIdFactory } from '../kernel/util/ids.ts'
import { createId } from '../kernel/util/ids.ts'
import type { Rng } from '../kernel/util/rng.ts'
import { SCHEMA_VERSION } from '../persistence/schema.ts'

export interface PersistentSessionOptions {
  persistence: CharacterPersistence
  instanceId: string
  provider: LLMProvider
  clock: Clock
  /** 必须是 SequentialIdFactory：跨会话要能按已有 id 继续编号 */
  ids: SequentialIdFactory
  rng: Rng
  budget?: Partial<ContextBudget>
  auditFile?: string | null
  /** 恢复流程中的探针查询（第 7 步会用一次） */
  probeQuery?: string
  /** 是否自动开新会话（默认 true） */
  resumeSession?: boolean
}

export class PersistentSession {
  readonly persistence: CharacterPersistence
  readonly instanceId: string
  readonly workspace: CharacterWorkspace
  readonly service: ConversationService
  readonly report: RehydrationReport
  readonly instance: CharacterInstance
  readonly template: CharacterTemplate
  session: SessionRecord | null
  #turns = 0
  #closed = false
  #clock: Clock

  private constructor(opts: {
    persistence: CharacterPersistence
    instanceId: string
    workspace: CharacterWorkspace
    service: ConversationService
    report: RehydrationReport
    instance: CharacterInstance
    template: CharacterTemplate
    session: SessionRecord | null
    clock: Clock
  }) {
    this.persistence = opts.persistence
    this.instanceId = opts.instanceId
    this.workspace = opts.workspace
    this.service = opts.service
    this.report = opts.report
    this.instance = opts.instance
    this.template = opts.template
    this.session = opts.session
    this.#clock = opts.clock
  }

  static open(opts: PersistentSessionOptions): PersistentSession {
    const rehydrator = new CharacterRehydrator({
      persistence: opts.persistence,
      instanceId: opts.instanceId,
      clock: opts.clock,
      ids: opts.ids,
      rng: opts.rng,
      auditFile: opts.auditFile ?? null,
      budget: opts.budget,
      probeQuery: opts.probeQuery,
      resumeSession: opts.resumeSession,
    })
    const { workspace, report, context } = rehydrator.rehydrate()

    // 关键：把 id 计数器抬到已有数量之上，否则新会话会生成与旧数据相同的 id。
    const rel = workspace.relationship
    opts.ids.seed('ms', rel.milestones.length)
    opts.ids.seed('bnd', rel.boundaries.length)
    opts.ids.seed('msg', workspace.pendingMessages().length)
    opts.ids.seed('prom', workspace.openPromises().length)
    // 时间线事件 id 也必须续号：否则新排的事件会与恢复出来的事件撞 id，
    // 导致 markFired 标记到错误的那一条，进而出现「事件永远触发不完」。
    opts.ids.seed('evt', workspace.timeline.size)
    const all = workspace.memory.list({ includeDeleted: true })
    opts.ids.seed('mem_ep', all.filter((m) => m.kind === 'episodic').length)
    opts.ids.seed('mem_us', all.filter((m) => m.kind === 'user').length)

    let session = report.resumedSession
    const service = new ConversationService({
      workspace,
      provider: opts.provider,
      clock: opts.clock,
      ids: opts.ids,
      context,
      onContextUsage: (usage) => {
        opts.persistence.recordContextRequest({
          id: createId('ctx'),
          instanceId: opts.instanceId,
          sessionId: session?.id ?? null,
          turnId: usage.turnId,
          provider: usage.provider,
          model: usage.model,
          budget: usage.plan?.budget ?? 0,
          estPromptTokens: usage.estPromptTokens,
          actualPromptTokens: usage.usage?.promptTokens ?? null,
          actualCompletionTokens: usage.usage?.completionTokens ?? null,
          degradation: usage.plan?.degradation ?? 'none',
          droppedHistoryTurns: usage.plan?.droppedHistoryTurns ?? 0,
          droppedMemoryIds: usage.plan?.droppedMemoryIds ?? [],
          digestedTurns: usage.plan?.digestedTurns ?? 0,
          createdAtSim: opts.clock.nowSim(),
        })
      },
    })

    opts.persistence.touchInstance(opts.instanceId, opts.clock.nowWall().toISOString())

    return new PersistentSession({
      persistence: opts.persistence,
      instanceId: opts.instanceId,
      workspace,
      service,
      report,
      instance: report.instance,
      template: report.template,
      session,
      clock: opts.clock,
    })
  }

  get turns(): number {
    return this.#turns
  }

  /** 一轮对话：写库（状态事件/记忆/用量）由 sink 与 onContextUsage 完成。 */
  async send(text: string): Promise<ConversationTurnResult> {
    if (this.#closed) throw new Error('会话已关闭，不能继续发送消息')
    const result = await this.service.send(text)
    this.#turns++
    if (this.session) this.persistence.countTurns(this.session.id)
    this.persistence.appendEvent({
      instanceId: this.instanceId,
      sessionId: this.session?.id ?? null,
      type: 'turn',
      atSim: this.#clock.nowSim(),
      atWall: this.#clock.nowWall().toISOString(),
      actor: 'conversation',
      summary: `第 ${this.#turns} 轮：${result.decision.action}`,
      data: {
        turnId: this.service.lastContextPlan ? 'ctx' : 'plain',
        action: result.decision.action,
        reply: result.reply.slice(0, 200),
        applied: result.appliedProposals.length,
        rejected: result.rejectedProposals.length,
        usage: result.usage,
        context: result.contextUsage ?? null,
        provider: result.provider,
        model: result.model,
      },
    })
    return result
  }

  /** 写一份状态快照（含当前事件序号），供下次恢复使用。 */
  saveSnapshot(): void {
    const state = this.workspace.dumpState()
    const sim = this.#clock.nowSim()
    const payload = {
      relationship: state.relationship,
      dynamic: state.dynamic,
      timeline: state.timeline,
      runtime: state.runtime,
    }
    const level = {
      schemaVersion: SCHEMA_VERSION,
      ...payload,
      lastEventSeq: this.persistence.lastEventSeq(this.instanceId),
      savedAtSim: sim,
      savedAtWall: this.#clock.nowWall().toISOString(),
    }
    this.persistence.saveState(this.instanceId, level)
    this.persistence.saveSnapshot(this.instanceId, level)
  }

  /** 结束会话：只关闭 Session，不触碰实例状态。 */
  close(reason: SessionEndReason = 'user_exit'): void {
    if (this.#closed) return
    this.saveSnapshot()
    if (this.session) {
      this.persistence.closeSession(this.session.id, { turnCount: this.#turns, endReason: reason })
    }
    this.#closed = true
  }

  get closed(): boolean {
    return this.#closed
  }
}

/** 便捷构造：打开数据库 + 定位实例 + 恢复会话。 */
export function openPersistentSession(opts: {
  database: CharacterDatabase
  instanceId: string
  provider: LLMProvider
  clock: Clock
  ids: SequentialIdFactory
  rng: Rng
  budget?: Partial<ContextBudget>
  auditFile?: string | null
  probeQuery?: string
}): { session: PersistentSession; persistence: CharacterPersistence } {
  const persistence = new Persistence(opts.database)
  const session = PersistentSession.open({
    persistence,
    instanceId: opts.instanceId,
    provider: opts.provider,
    clock: opts.clock,
    ids: opts.ids,
    rng: opts.rng,
    budget: opts.budget,
    auditFile: opts.auditFile,
    probeQuery: opts.probeQuery,
  })
  return { session, persistence }
}
