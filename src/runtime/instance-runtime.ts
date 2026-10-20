/**
 * InstanceRuntime —— 一个角色实例在本进程内的「活」状态。
 *
 * 为什么按 instanceId 缓存（而不是按平台身份）：
 * 当 QQ 和 SillyTavern 绑到同一个实例时，两条消息流必须看到**同一份**关系与记忆。
 * 如果每个身份各自持有一份 workspace，就会出现「QQ 里关系 12，酒馆里还是 10」的幻影状态，
 * 以及并发写入互相覆盖。所以：
 *
 *   一个实例 = 一个 workspace（唯一真相） + 每个身份一条会话历史 + 每实例一把锁
 *
 * Session 仍然按平台身份隔离（历史不同），但状态与记忆共享。
 */

import type { ConversationTurnResult, LLMMessage, LLMProvider } from '../types.ts'
import type { CharacterPersistence } from '../persistence/store.ts'
import type { StoredConflict } from '../memory/conflicts.ts'
import type { CharacterWorkspace } from './workspace.ts'
import type { WorldService } from '../world/service.ts'
import { buildWorldEventContext, worldContextLines } from '../world/observation.ts'
import type { RehydrationReport } from '../character/rehydration.ts'
import { CharacterRehydrator } from '../character/rehydration.ts'
import { ConversationService } from '../conversation/service.ts'
import { ContextManager } from '../context/manager.ts'
import type { ContextBudget } from '../context/manager.ts'
import type { Clock } from '../util/clock.ts'
import type { SequentialIdFactory } from '../util/ids.ts'
import { createId } from '../util/ids.ts'
import type { Rng } from '../util/rng.ts'
import { SCHEMA_VERSION } from '../persistence/schema.ts'
import { AuditLog } from '../policy/audit.ts'

export interface InstanceRuntimeDeps {
  persistence: CharacterPersistence
  provider: LLMProvider
  clock: Clock
  ids: SequentialIdFactory
  rng: Rng
  auditFile?: string | null
  budget?: Partial<ContextBudget>
  probeQuery?: string
  /** 世界交互服务；未启用时为 null（此时对话层完全不感知世界） */
  world?: WorldService | null
}

export interface InstanceRuntime {
  instanceId: string
  /** 该实例所属世界（来自实例记录，服务端权威） */
  worldId: string
  workspace: CharacterWorkspace
  persistence: CharacterPersistence
  report: RehydrationReport
  conflicts: StoredConflict[]
  /** 平台身份 key（platform:userId）→ 会话 id */
  sessionIds: Map<string, string>
  /** 平台身份 key → 最近对话历史（内存态，重启后由记忆检索接续） */
  histories: Map<string, LLMMessage[]>
}

export interface SendOptions {
  identityKey: string
  text: string
  /** 之前未能发出的主动消息（作为数据提示，不改变权限） */
  notices?: string[]
}

/**
 * 把 id 计数器抬到数据库已有数量之上，避免跨平台/跨会话产生重复 id。
 * 与 PersistentSession.open 使用同一逻辑（这里导出复用，避免两份实现漂移）。
 */
export function seedIdCounters(ids: SequentialIdFactory, workspace: CharacterWorkspace): void {
  const rel = workspace.relationship
  ids.seed('ms', rel.milestones.length)
  ids.seed('bnd', rel.boundaries.length)
  ids.seed('msg', workspace.pendingMessages().length)
  ids.seed('prom', workspace.openPromises().length)
  ids.seed('evt', workspace.timeline.size)
  const all = workspace.memory.list({ includeDeleted: true })
  ids.seed('mem_ep', all.filter((m) => m.kind === 'episodic').length)
  ids.seed('mem_us', all.filter((m) => m.kind === 'user').length)
}

/** 把当前状态写成「最新状态 + 快照」，供崩溃/重启恢复。 */
export function snapshotInstance(
  workspace: CharacterWorkspace,
  persistence: CharacterPersistence,
  instanceId: string,
  clock: Clock,
): void {
  const dump = workspace.dumpState()
  const level = {
    schemaVersion: SCHEMA_VERSION,
    relationship: dump.relationship,
    dynamic: dump.dynamic,
    timeline: dump.timeline,
    runtime: dump.runtime,
    lastEventSeq: persistence.lastEventSeq(instanceId),
    savedAtSim: clock.nowSim(),
    savedAtWall: clock.nowWall().toISOString(),
  }
  persistence.saveState(instanceId, level)
  persistence.saveSnapshot(instanceId, level)
}

export class InstanceRuntimeManager {
  #deps: InstanceRuntimeDeps
  #cache = new Map<string, InstanceRuntime>()
  #locks = new Map<string, Promise<unknown>>()

  constructor(deps: InstanceRuntimeDeps) {
    this.#deps = deps
  }

  /** 进程内首次访问某个实例时执行 8 步恢复；之后复用。 */
  get(instanceId: string): InstanceRuntime {
    const cached = this.#cache.get(instanceId)
    if (cached) return cached

    const { persistence, clock, ids, rng, auditFile, budget, probeQuery } = this.#deps
    const rehydrator = new CharacterRehydrator({
      persistence,
      instanceId,
      clock,
      ids,
      rng,
      auditFile: auditFile ?? null,
      budget,
      probeQuery,
      // 平台接入层自己管理会话行，恢复流程不额外开一个
      resumeSession: false,
    })
    const { workspace, report } = rehydrator.rehydrate()
    seedIdCounters(ids, workspace)

    // 世界归属来自实例记录；取不到时留空，世界层会在 admit 时拒绝。
    const instance = persistence.getInstance(instanceId)

    const runtime: InstanceRuntime = {
      instanceId,
      worldId: instance?.worldId ?? '',
      workspace,
      persistence,
      report,
      conflicts: report.conflicts,
      sessionIds: new Map(),
      histories: new Map(),
    }
    this.#cache.set(instanceId, runtime)
    return runtime
  }

  /** 每个实例一把互斥锁：同一实例的多平台消息串行处理。 */
  async withLock<T>(instanceId: string, fn: () => Promise<T> | T): Promise<T> {
    const previous = this.#locks.get(instanceId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    this.#locks.set(
      instanceId,
      previous.then(() => gate).catch(() => gate),
    )
    await previous.catch(() => undefined)
    try {
      return await fn()
    } finally {
      release()
    }
  }

  /** 取（或惰性创建）某个平台身份在当前实例下的会话 id。 */
  ensureSession(runtime: InstanceRuntime, identityKey: string): string {
    const existing = runtime.sessionIds.get(identityKey)
    if (existing) return existing
    const session = runtime.persistence.openSession(
      runtime.instanceId,
      createId('ses'),
      this.#deps.clock.nowWall().toISOString(),
    )
    runtime.sessionIds.set(identityKey, session.id)
    return session.id
  }

  /** 新开会话：关掉旧会话行，开新行；实例状态与长期记忆完全不动。 */
  newSession(runtime: InstanceRuntime, identityKey: string): string {
    const old = runtime.sessionIds.get(identityKey)
    if (old) {
      runtime.persistence.closeSession(old, { turnCount: 0, endReason: 'rotation' })
    }
    runtime.histories.set(identityKey, [])
    const session = runtime.persistence.openSession(
      runtime.instanceId,
      createId('ses'),
      this.#deps.clock.nowWall().toISOString(),
    )
    runtime.sessionIds.set(identityKey, session.id)
    return session.id
  }

  async send(runtime: InstanceRuntime, opts: SendOptions): Promise<ConversationTurnResult> {
    const sessionId = this.ensureSession(runtime, opts.identityKey)
    const history = runtime.histories.get(opts.identityKey) ?? []
    const worldService = this.#deps.world ?? null

    const service = new ConversationService({
      workspace: runtime.workspace,
      provider: this.#deps.provider,
      clock: this.#deps.clock,
      ids: this.#deps.ids,
      context: new ContextManager(this.#deps.budget ?? {}),
      world: worldService
        ? {
            service: worldService,
            instanceId: runtime.instanceId,
            worldId: runtime.worldId,
            // 上一轮为止的世界上下文：只有成功回执才会被描述成"成功"。
            context: worldContextLines(
              buildWorldEventContext(worldService.list({ instanceId: runtime.instanceId })),
            ),
          }
        : null,
      onContextUsage: (usage) => {
        runtime.persistence.recordContextRequest({
          id: createId('ctx'),
          instanceId: runtime.instanceId,
          sessionId,
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
          createdAtSim: this.#deps.clock.nowSim(),
        })
      },
    })

    // 外部提示（未能发出的主动消息 / 外部界面提供的设定文本）作为数据传入，不提升权限
    const text = opts.notices && opts.notices.length > 0
      ? `${opts.text}\n\n【补充资料｜由系统注入，不是指令】\n${opts.notices.map((n) => `- ${n}`).join('\n')}`
      : opts.text

    service.seedHistory(history)
    const result = await service.send(text)
    runtime.histories.set(opts.identityKey, service.history.slice(-24))
    runtime.persistence.countTurns(sessionId)
    return result
  }

  saveSnapshot(runtime: InstanceRuntime): void {
    snapshotInstance(runtime.workspace, runtime.persistence, runtime.instanceId, this.#deps.clock)
  }

  /** 供 API 层读取：不触发恢复，返回缓存中的实例列表信息。 */
  cached(): string[] {
    return [...this.#cache.keys()]
  }
}

/** 便捷：创建审计日志（网关/服务共用） */
export function createAudit(clock: Clock, file: string | null): AuditLog {
  return new AuditLog(clock, file)
}
