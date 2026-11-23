/**
 * AgentCore：一个角色的六语义内核（V0.5）。
 *
 * 一个角色 = 六个语义槽 + 一个状态存储 + 一条提议—裁决通道：
 *
 *   self         SelfSlot          只读人格 + 身心状况
 *   situation    SituationStore    由观察推出的处境信念
 *   observation  ObservationLog    只追加的感知流
 *   memory       MemoryStore       带出处的记忆（关系认识也在 Memory 语义下）
 *   motivation   MotivationSlot    内驱力、目标、承诺账本
 *   affordance   AffordanceRegistry 各扩展登记的可行动作
 *
 * 所有持久状态的改变都走 `submitProposals` → `PolicyEngine`：
 * 能力由 actor 身份决定，与对话内容无关；每次落地/拒绝都写审计，并标注所属语义。
 *
 * 内核不认识任何平台、任何具体世界、任何对话协议。陪伴角色（CharacterWorkspace）、
 * 箱庭里的自主角色、Free Roam 的斗场角色，都是建在它上面的扩展。
 */

import type {
  CharacterDynamicState,
  CharacterProfile,
  Commitment,
  PolicyDecision,
  RejectedProposal,
  RelationshipState,
  StateProposal,
} from './types.ts'
import type { Clock } from './util/clock.ts'
import { HOUR } from './util/clock.ts'
import type { IdFactory } from './util/ids.ts'
import type { Rng } from './util/rng.ts'
import type { SnapshotStore } from './storage/snapshot.ts'
import { AuditLog } from './policy/audit.ts'
import { OWNER_ACTOR, RUNTIME_ACTOR, PolicyEngine } from './policy/policy.ts'
import type { Actor } from './policy/policy.ts'
import { MemoryStore } from './memory/store.ts'
import type { MemoryWriteInput } from './memory/store.ts'
import { applyProposal, canonicalizeProposal, createInitialDynamicState, createInitialRelationship } from './state.ts'
import { semanticOf } from './semantics/index.ts'
import { SelfSlot } from './semantics/self.ts'
import { SituationStore } from './semantics/situation.ts'
import { ObservationLog } from './semantics/observation.ts'
import { MotivationSlot } from './semantics/motivation.ts'
import { AffordanceRegistry } from './semantics/affordance.ts'
import type { DriveProfile } from './semantics/drives.ts'
import type { Integrity } from './integrity/index.ts'
import { canonicalJson } from './integrity/canonical.ts'

export interface AgentCoreOptions {
  profile: CharacterProfile
  clock: Clock
  ids: IdFactory
  rng: Rng
  snapshot: SnapshotStore
  audit?: AuditLog
  policy?: PolicyEngine
  /** 内驱力规格（角色配置）；不启用自主运行可省略 */
  drives?: DriveProfile | null
  /** 感知缓冲上限 */
  observationMax?: number
  /**
   * 完整性层（宪法 K1–K6）。提供时：每条审计事件都镜像进哈希链账本（带身份指纹），
   * 人设替换会成为一条身份修订记录。
   */
  integrity?: Integrity | null
}

export interface ProposalOutcome {
  applied: StateProposal[]
  rejected: RejectedProposal[]
}

/** 一批提议落地之后的通知（扩展用它接持久化旁路）。 */
export interface StateAppliedEvent {
  source: string
  proposals: StateProposal[]
  sim: number
  relationshipTouched: boolean
}

/** 内核自己的运行时数据（关系写入限速窗口、承诺账本），由扩展并入其快照 section。 */
export interface KernelRuntimeState {
  relationshipWrites: number[]
  promises: Commitment[]
}

export class AgentCore {
  readonly memory: MemoryStore
  readonly policy: PolicyEngine
  readonly audit: AuditLog
  readonly self: SelfSlot
  readonly situation: SituationStore
  readonly observation: ObservationLog
  readonly motivation: MotivationSlot
  readonly affordance: AffordanceRegistry
  /** 完整性层；未启用为 null */
  readonly integrity: Integrity | null

  protected readonly clock: Clock
  protected readonly ids: IdFactory
  protected readonly rng: Rng
  protected readonly snapshot: SnapshotStore
  #relationshipWrites: number[] = []

  constructor(opts: AgentCoreOptions) {
    this.clock = opts.clock
    this.ids = opts.ids
    this.rng = opts.rng
    this.snapshot = opts.snapshot
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
    this.self = new SelfSlot(
      () => this.memory.getProfile(),
      () => this.memory.getDynamicState(),
    )
    this.situation = new SituationStore()
    this.observation = new ObservationLog({ max: opts.observationMax })
    this.motivation = new MotivationSlot({
      dynamic: () => this.memory.getDynamicState(),
      now: () => this.clock.nowSim(),
      drives: opts.drives ?? null,
    })
    this.affordance = new AffordanceRegistry()
    this.integrity = opts.integrity ?? null
    if (this.integrity) {
      const integrity = this.integrity
      // K3：任何落地、拒绝、注入降级……都是一条账本记录。内容先规范化，保证可哈希、可复制。
      this.audit.onAppend((event) => {
        integrity.record(`audit.${event.type}`, event.actor, JSON.parse(canonicalJson({ summary: event.summary, data: event.data })))
      })
    }

    // 快照 section 的注册顺序就是恢复顺序：内核先注册记忆，扩展再注册自己的。
    this.snapshot.register(this.memory)
  }

  /* ---------------------------------------------------------------- 读取 */

  get id(): string {
    return this.memory.getProfile().id
  }

  get profile(): Readonly<CharacterProfile> {
    return this.memory.getProfile()
  }

  get dynamicState(): CharacterDynamicState {
    return this.memory.getDynamicState()
  }

  get relationship(): RelationshipState {
    return this.memory.getRelationship()
  }

  nowSim(): number {
    return this.clock.nowSim()
  }

  /* ------------------------------------------------------- 提议 → 落地 */

  /**
   * 提交提议。全部经过 Policy 评估：通过的落地并写审计，拒绝的原样返回给调用方。
   * 这是任何来源影响角色状态的唯一通道。
   */
  submitProposals(proposals: StateProposal[], actor: Actor, opts: { source?: string } = {}): ProposalOutcome {
    const applied: StateProposal[] = []
    const rejected: RejectedProposal[] = []
    const source = opts.source ?? actor.id
    let relationshipTouched = false

    for (const raw of proposals) {
      const slice = { dynamic: this.dynamicState, relationship: this.relationship }
      const canonical = canonicalizeProposal(raw, slice)
      const semantic = semanticOf(raw.target, raw.path)
      const decision: PolicyDecision = this.policy.evaluate(canonical, {
        actor,
        profile: this.profile,
        relationship: this.relationship,
        dynamic: this.dynamicState,
        nowSim: this.clock.nowSim(),
        relationshipWritesLastHour: this.#writesLastHour(),
      })

      if (!decision.allowed) {
        rejected.push({ proposal: raw, decision })
        this.audit.append('proposal_rejected', actor.id, `${raw.target}.${raw.path} 被拒绝（${decision.code}）`, {
          source,
          semantic,
          code: decision.code,
          reasons: decision.reasons,
          proposal: raw as unknown as Record<string, unknown>,
        })
        if (raw.target === 'profile') {
          this.audit.append('profile_write_attempt', actor.id, '尝试写入核心人格被拒绝', { source, reason: raw.reason })
        }
        if (raw.target === 'policy') {
          this.audit.append('policy_write_attempt', actor.id, '尝试写入权限策略被拒绝', { source, reason: raw.reason })
        }
        continue
      }

      const effective = decision.adjusted ?? canonical
      const result = applyProposal(effective, slice, this.clock.nowSim())
      if (!result.applied) {
        rejected.push({
          proposal: raw,
          decision: { allowed: false, code: 'PATH_NOT_ALLOWED', severity: 'deny', reasons: [result.note] },
        })
        this.audit.append('proposal_rejected', actor.id, result.note, { source, semantic })
        continue
      }

      this.memory.setDynamicState(result.state.dynamic)
      this.memory.setRelationship(result.state.relationship)
      applied.push(effective)
      if (effective.target === 'relationship') relationshipTouched = true
      this.audit.append('proposal_applied', actor.id, `${effective.target}.${effective.path} 已更新`, {
        source,
        semantic,
        code: decision.code,
        reasons: decision.reasons,
        value: effective.value,
        reason: effective.reason,
      })
    }

    // 限速按「批次」计：一次里程碑带来的多条关系变更算一次写入。
    if (relationshipTouched) this.#relationshipWrites.push(this.clock.nowSim())

    if (applied.length > 0) {
      this.afterApplied({ source, proposals: applied, sim: this.clock.nowSim(), relationshipTouched })
    }
    return { applied, rejected }
  }

  /** 扩展钩子：一批提议落地之后（持久化旁路在这里接）。默认什么都不做。 */
  protected afterApplied(_evt: StateAppliedEvent): void {}

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
    const verdict = this.policy.evaluateMemoryWrite({ content: input.content, status: input.status, actor })
    if (!verdict.allowed) {
      this.audit.append('proposal_rejected', actor.id, '记忆写入被拒绝：权限不足', {
        semantic: 'memory',
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

  /* ------------------------------------------------------------- 管理操作 */

  /**
   * 显式替换核心人格。只有具备 profile:write 的 actor 能成功；
   * 对话路径拿不到这个能力，这条路径只为数据迁移/测试保留。
   */
  replaceProfile(next: CharacterProfile, actor: Actor = OWNER_ACTOR): boolean {
    if (!actor.capabilities.has('profile:write')) {
      this.audit.append('profile_write_attempt', actor.id, '缺少 profile:write，替换核心人格被拒绝', {
        targetProfileId: next.id,
      })
      return false
    }
    this.memory.replaceProfileForAdmin(next)
    // K1：人设替换 = 身份修订，修订记录携带新指纹
    this.integrity?.reviseIdentity(actor, next, `管理操作替换核心人格（v${next.version}）`)
    this.audit.append('proposal_applied', actor.id, '核心人格被显式管理操作替换', {
      semantic: 'self',
      targetProfileId: next.id,
      version: next.version,
    })
    return true
  }

  save(): void {
    this.snapshot.save()
    this.audit.append('snapshot_saved', 'runtime', '快照已保存', {
      atSim: this.clock.nowSim(),
      file: this.snapshot.filePath,
    })
  }

  /* ------------------------------------------------------- 内核运行时数据 */

  protected kernelRuntimeState(): KernelRuntimeState {
    return { relationshipWrites: [...this.#relationshipWrites], promises: this.motivation.toJSON() }
  }

  protected restoreKernelRuntime(v: Partial<KernelRuntimeState>): void {
    this.#relationshipWrites = [...(v.relationshipWrites ?? [])]
    this.motivation.fromJSON(v.promises ?? [])
  }

  #writesLastHour(): number {
    const since = this.clock.nowSim() - HOUR
    this.#relationshipWrites = this.#relationshipWrites.filter((t) => t >= since)
    return this.#relationshipWrites.length
  }
}
