/**
 * Character Rehydration —— 新会话恢复流程（8 步）。
 *
 * 顺序固定，每一步都写进报告，失败会显式标注而不是静默降级：
 *   1. Load Character Profile（从 Template 表读，不是从状态里读）
 *   2. Validate Profile Version（版本 + 内容哈希）
 *   3. Load Latest State Snapshot（快照表优先，回退到 instance_state）
 *   4. Replay Valid Events（重放快照之后的 state_patch / event_fired）
 *   5. Restore Relationship State
 *   6. Retrieve Relevant Memories（并检测冲突）
 *   7. Build Context Within Budget（用真实 ContextManager 跑一次，报告降级情况）
 *   8. Resume Conversation（开一个新的 Session）
 *
 * 关键点：**人格来自 Template，状态来自快照 + 事件**。两者分开，所以
 * 「对话摘要出错」不可能污染人格，「事件重放」也不可能改掉人格。
 */

import type { CharacterDynamicState, CharacterProfile, RelationshipState, StateProposal, TimelineEvent } from '../types.ts'
import type { CharacterTemplate } from './template.ts'
import { checkTemplateVersion, verifyTemplate } from './template.ts'
import type { TemplateVersionCheck } from './template.ts'
import type { CharacterInstance, SessionRecord } from './instance.ts'
import type { CharacterPersistence, PersistedEvent, PersistedState } from '../persistence/store.ts'
import type { StoredConflict } from '../kernel/memory/conflicts.ts'
import { CharacterWorkspace } from '../runtime/workspace.ts'
import type { WorkspaceStateDump } from '../runtime/workspace.ts'
import { applyProposal, canonicalizeProposal } from '../kernel/state.ts'
import { createInitialDynamicState, createInitialRelationship } from '../kernel/state.ts'
import { SnapshotStore } from '../kernel/storage/snapshot.ts'
import { AuditLog } from '../kernel/policy/audit.ts'
import type { Clock } from '../kernel/util/clock.ts'
import type { IdFactory } from '../kernel/util/ids.ts'
import { createId } from '../kernel/util/ids.ts'
import type { Rng } from '../kernel/util/rng.ts'
import { SqliteSink } from '../persistence/sink.ts'
import { ContextManager } from '../context/manager.ts'
import type { ContextBudget, ContextPlan } from '../context/manager.ts'
import { buildSystemPrompt, CAPABILITY_NOTE } from '../conversation/context.ts'
import type { BehaviorDecision } from '../types.ts'
import { Integrity } from '../kernel/integrity/index.ts'
import { Ledger } from '../kernel/integrity/ledger.ts'
import type { LedgerVerification } from '../kernel/integrity/ledger.ts'
import { SqliteLedgerSink } from '../persistence/ledger-sink.ts'

export interface RehydrationStep {
  index: number
  step: string
  ok: boolean
  detail: string
}

export interface RehydrationReport {
  instance: CharacterInstance
  template: CharacterTemplate
  templateCheck: TemplateVersionCheck
  steps: RehydrationStep[]
  snapshot: {
    found: boolean
    id: number | null
    source: 'snapshots' | 'instance_state' | 'initial'
    lastEventSeq: number
    savedAtSim: number | null
  }
  replayedEvents: number
  replayedPatches: number
  invalidEvents: number
  truncatedReplay: boolean
  memoriesLoaded: number
  conflicts: StoredConflict[]
  relationship: RelationshipState
  contextPlan: Pick<ContextPlan, 'budget' | 'estPromptTokens' | 'degradation' | 'fits' | 'droppedHistoryTurns' | 'droppedMemoryIds' | 'protectedTokens'> | null
  resumedSession: SessionRecord | null
  /** 完整性账本的核对结果（V0.6）；未启用为 null */
  ledger: { records: number; restored: boolean; verification: LedgerVerification } | null
  warnings: string[]
}

export interface RehydrationOptions {
  persistence: CharacterPersistence
  instanceId: string
  clock: Clock
  ids: IdFactory
  rng: Rng
  /** 恢复时需要重建的工作区依赖 */
  auditFile?: string | null
  budget?: Partial<ContextBudget>
  /** 第 7 步用来验证预算组装的探针查询 */
  probeQuery?: string
  maxReplayEvents?: number
  /** 是否在最后开一个新会话（第 8 步） */
  resumeSession?: boolean
  /** 是否启用完整性账本（V0.6 · 宪法 K3），默认启用 */
  integrity?: boolean
  /** 宪法文本的哈希（写进新账本的创世记录） */
  constitutionHash?: string | null
}

export interface RehydratedWorkspace {
  workspace: CharacterWorkspace
  report: RehydrationReport
  sink: SqliteSink
  context: ContextManager
}

const ALLOWED_TARGETS = new Set(['dynamic', 'relationship', 'memory', 'profile', 'policy', 'timeline'])
const ALLOWED_OPS = new Set(['set', 'increment', 'append', 'delete'])

function isProposal(value: unknown): value is StateProposal {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.target === 'string' &&
    ALLOWED_TARGETS.has(v.target) &&
    typeof v.op === 'string' &&
    ALLOWED_OPS.has(v.op) &&
    typeof v.path === 'string' &&
    v.path.length > 0
  )
}

function sanitizeTimeline(value: unknown): TimelineEvent[] | null {
  if (!Array.isArray(value)) return null
  const out: TimelineEvent[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const e = item as Record<string, unknown>
    if (typeof e.id !== 'string' || typeof e.atSim !== 'number' || typeof e.title !== 'string') continue
    out.push({
      id: e.id,
      kind: (e.kind as TimelineEvent['kind']) ?? 'life',
      atSim: e.atSim,
      order: typeof e.order === 'number' ? e.order : 100,
      title: e.title,
      description: typeof e.description === 'string' ? e.description : '',
      fired: e.fired === true,
      firedAtSim: typeof e.firedAtSim === 'number' ? e.firedAtSim : null,
      payload: (e.payload as Record<string, unknown>) ?? {},
    })
  }
  return out
}

export class CharacterRehydrator {
  #opts: RehydrationOptions

  constructor(opts: RehydrationOptions) {
    this.#opts = opts
  }

  rehydrate(): RehydratedWorkspace {
    const { persistence, instanceId, clock, ids, rng } = this.#opts
    const steps: RehydrationStep[] = []
    const warnings: string[] = []
    const push = (step: string, ok: boolean, detail: string): void => {
      steps.push({ index: steps.length + 1, step, ok, detail })
      if (!ok) warnings.push(`${step}: ${detail}`)
    }

    // ---------- 1. Load Character Profile ----------
    const instance = persistence.requireInstance(instanceId)
    const template = persistence.getTemplate(instance.templateId, instance.templateVersion)
    push(
      'Load Character Profile',
      template !== null,
      template ? `加载模板 ${template.id}@${template.version}` : `模板 ${instance.templateId}@${instance.templateVersion} 不存在`,
    )
    if (!template) throw new Error(`无法恢复：模板缺失 ${instance.templateId}@${instance.templateVersion}`)

    // ---------- 2. Validate Profile Version ----------
    let templateCheck: TemplateVersionCheck
    try {
      verifyTemplate(template)
      templateCheck = checkTemplateVersion(template, {
        templateId: instance.templateId,
        templateVersion: instance.templateVersion,
        templateHash: instance.templateHash,
      })
    } catch (err) {
      templateCheck = { ok: false, code: 'HASH_MISMATCH', detail: (err as Error).message }
    }
    push('Validate Profile Version', templateCheck.ok, templateCheck.detail)
    if (!templateCheck.ok) throw new Error(`模板校验失败：${templateCheck.detail}`)

    // ---------- 3. Load Latest State Snapshot ----------
    const snapshot = persistence.latestSnapshot(instanceId)
    const stateRow = snapshot ? null : persistence.loadState(instanceId)
    const base: PersistedState | null = snapshot?.state ?? stateRow
    const snapshotSource: RehydrationReport['snapshot']['source'] = snapshot
      ? 'snapshots'
      : stateRow
        ? 'instance_state'
        : 'initial'
    const baseSeq = base?.lastEventSeq ?? 0
    const simNow = Math.max(clock.nowSim(), base?.savedAtSim ?? 0)
    if (base && base.savedAtSim > clock.nowSim() && typeof clock.setSim === 'function') {
      clock.setSim(base.savedAtSim)
    }
    push(
      'Load Latest State Snapshot',
      true,
      snapshot
        ? `快照 #${snapshot.id}（sim=${snapshot.savedAtSim}, seq=${snapshot.lastEventSeq}）`
        : base
          ? `使用 instance_state（seq=${base.lastEventSeq}）`
          : '没有历史状态，按初始状态启动',
    )

    // ---------- 4. Replay Valid Events ----------
    const maxReplay = this.#opts.maxReplayEvents ?? 5000
    const events = persistence.listEvents(instanceId, { afterSeq: baseSeq, limit: maxReplay + 1 })
    const truncated = events.length > maxReplay
    const replayable = truncated ? events.slice(0, maxReplay) : events

    let dynamic: CharacterDynamicState = base?.dynamic ?? createInitialDynamicState(template.profile, simNow)
    let relationship: RelationshipState = base?.relationship ?? createInitialRelationship(template.profile)
    let timeline: TimelineEvent[] = base?.timeline ?? []
    const runtime = base?.runtime ?? {}

    let replayedPatches = 0
    let invalidEvents = 0
    let replayedEvents = 0
    for (const evt of replayable) {
      if (evt.type === 'state_patch') {
        const proposals = (evt.data.proposals as unknown[]) ?? []
        const valid = proposals.filter(isProposal)
        invalidEvents += proposals.length - valid.length
        if (valid.length === 0) continue
        let slice = { dynamic, relationship }
        for (const raw of valid) {
          const canonical = canonicalizeProposal(raw, slice)
          const applied = applyProposal(canonical, slice, evt.atSim)
          if (applied.applied) slice = applied.state
          else {
            invalidEvents++
            warnings.push(`事件 #${evt.seq} 的补丁无法应用：${applied.note}`)
          }
        }
        dynamic = slice.dynamic
        relationship = slice.relationship
        replayedPatches++
        replayedEvents++
        const tl = sanitizeTimeline(evt.data.timeline)
        if (tl) timeline = tl
      } else if (evt.type === 'event_fired') {
        const tl = sanitizeTimeline(evt.data.timeline)
        if (tl) {
          timeline = tl
          replayedEvents++
        } else {
          invalidEvents++
        }
      }
    }
    // 完整性账本（宪法 K3）：恢复并逐条核对哈希链；断链如实报告，不静默修复
    let integrity: Integrity | null = null
    let ledgerReport: RehydrationReport['ledger'] = null
    if (this.#opts.integrity !== false) {
      const sink = new SqliteLedgerSink(persistence, instanceId)
      const stored = persistence.loadLedger(instanceId)
      let ledger: Ledger
      let verification: LedgerVerification
      if (stored.records.length > 0) {
        const restored = Ledger.restore({ clock, sink }, stored.records, stored.contents)
        ledger = restored.ledger
        verification = restored.verification
      } else {
        ledger = new Ledger({ clock, sink })
        verification = { ok: true, records: 0, erased: 0 }
      }
      integrity = new Integrity({
        clock,
        ledger,
        constitutionHash: this.#opts.constitutionHash ?? null,
        subject: { id: template.profile.id, persona: template.profile },
      })
      ledgerReport = { records: ledger.size, restored: stored.records.length > 0, verification }
      if (!verification.ok) warnings.push(`完整性账本在 #${verification.brokenAt} 断开：${verification.reason}`)
    }
    const ledgerDetail = ledgerReport
      ? ledgerReport.verification.ok
        ? `；账本 ${ledgerReport.records} 条，哈希链完好`
        : `；账本在 #${ledgerReport.verification.brokenAt} 断开（${ledgerReport.verification.reason}）`
      : ''
    push(
      'Replay Valid Events',
      !truncated && invalidEvents === 0 && (ledgerReport?.verification.ok ?? true),
      `重放 ${replayedEvents} 个事件（补丁 ${replayedPatches}），跳过非法 ${invalidEvents} 个` +
        (truncated ? `；已达上限 ${maxReplay}，剩余事件未重放` : '') +
        ledgerDetail,
    )

    // ---------- 5. Restore Relationship State ----------
    const memories = persistence.listMemories(instanceId, { includeDeleted: true })
    const dump: WorkspaceStateDump = {
      relationship,
      dynamic,
      timeline,
      runtime,
      episodic: memories.filter((m) => m.kind === 'episodic'),
      user: memories.filter((m) => m.kind === 'user'),
    }

    const snapshotStore = new SnapshotStore(
      ':no-file:',
      1,
      () => ({ sim: clock.nowSim(), wall: clock.nowWall().toISOString() }),
    )
    // 用「不落盘」的 SnapshotStore：SQLite 才是这一版的权威存储。
    const workspace = new CharacterWorkspace({
      profile: template.profile as CharacterProfile,
      voice: template.voice,
      clock,
      ids,
      rng,
      snapshot: snapshotStore,
      audit: new AuditLog(clock, this.#opts.auditFile ?? null),
      integrity,
    })
    workspace.restoreState(dump)
    push(
      'Restore Relationship State',
      true,
      `信任=${relationship.trust} 熟悉度=${relationship.familiarity} 阶段=${relationship.stage} 里程碑=${relationship.milestones.length}`,
    )

    // ---------- 6. Retrieve Relevant Memories ----------
    const conflicts = persistence.detectAndStoreConflicts(instanceId, clock.nowSim())
    push(
      'Retrieve Relevant Memories',
      true,
      `加载 ${dump.episodic.length + dump.user.length} 条记忆` +
        (conflicts.length > 0 ? `，发现 ${conflicts.length} 处冲突` : '，无冲突'),
    )

    // ---------- 7. Build Context Within Budget ----------
    const context = new ContextManager(this.#opts.budget ?? {})
    const probeQuery = this.#opts.probeQuery ?? '上次我们聊到的那件事'
    const retrieved = workspace.memory.search(probeQuery, {
      nowSim: clock.nowSim(),
      limit: context.budget.memoryLimit,
      budgetChars: context.budget.memoryBudgetChars,
    })
    const neutralDecision: BehaviorDecision = {
      action: 'respond',
      scores: { respond: 0.5, negotiate: 0.15, decline: 0.1, wait: 0.1, proactive_contact: 0 },
      rationale: ['恢复流程中的上下文预算探测'],
      responseStyle: 'warm_measured',
      proactiveIntent: null,
      proactiveMessage: null,
      nextActionSim: null,
    }
    const plan = context.plan({
      protectedSystem: buildSystemPrompt({
        profile: template.profile,
        decision: neutralDecision,
        capabilityNote: CAPABILITY_NOTE,
      }),
      memories: retrieved.map((r) => r.entry),
      history: [],
      userText: probeQuery,
      nowSim: clock.nowSim(),
    })
    push(
      'Build Context Within Budget',
      plan.fits,
      `预算 ${plan.budget} tokens，受保护 ${plan.protectedTokens}，估算占用 ${plan.estPromptTokens}，降级=${plan.degradation}`,
    )

    // ---------- 8. Resume Conversation ----------
    let session: SessionRecord | null = null
    if (this.#opts.resumeSession !== false) {
      // 会话 id 用熵生成的全局唯一 id：它是基础设施标识，不参与世界状态确定性
      session = persistence.openSession(instanceId, createId('ses'), clock.nowWall().toISOString())
      push('Resume Conversation', true, `新会话 ${session.id} 已创建（角色状态与记忆沿用实例）`)
    } else {
      push('Resume Conversation', true, '跳过（resumeSession=false）')
    }

    const sink = new SqliteSink({
      persistence,
      instanceId,
      clock,
      getSessionId: () => session?.id ?? null,
    })
    workspace.setStateSink(sink)
    workspace.memory.setSink(sink)

    return {
      workspace,
      report: {
        instance,
        template,
        templateCheck,
        steps,
        snapshot: {
          found: snapshot !== null || stateRow !== null,
          id: snapshot?.id ?? null,
          source: snapshotSource,
          lastEventSeq: baseSeq,
          savedAtSim: base?.savedAtSim ?? null,
        },
        replayedEvents,
        replayedPatches,
        invalidEvents,
        truncatedReplay: truncated,
        memoriesLoaded: dump.episodic.length + dump.user.length,
        conflicts,
        relationship,
        contextPlan: {
          budget: plan.budget,
          estPromptTokens: plan.estPromptTokens,
          degradation: plan.degradation,
          fits: plan.fits,
          droppedHistoryTurns: plan.droppedHistoryTurns,
          droppedMemoryIds: plan.droppedMemoryIds,
          protectedTokens: plan.protectedTokens,
        },
        resumedSession: session,
        ledger: ledgerReport,
        warnings,
      },
      sink,
      context,
    }
  }
}

export function replayState(
  base: Pick<PersistedState, 'dynamic' | 'relationship' | 'timeline'>,
  events: PersistedEvent[],
): { dynamic: CharacterDynamicState; relationship: RelationshipState; timeline: TimelineEvent[]; applied: number } {
  let dynamic = structuredClone(base.dynamic)
  let relationship = structuredClone(base.relationship)
  let timeline = structuredClone(base.timeline)
  let applied = 0
  for (const evt of events) {
    if (evt.type !== 'state_patch') continue
    const proposals = ((evt.data.proposals as unknown[]) ?? []).filter(isProposal)
    let slice = { dynamic, relationship }
    for (const p of proposals) {
      const result = applyProposal(canonicalizeProposal(p, slice), slice, evt.atSim)
      if (result.applied) slice = result.state
    }
    dynamic = slice.dynamic
    relationship = slice.relationship
    const tl = sanitizeTimeline(evt.data.timeline)
    if (tl) timeline = tl
    applied++
  }
  return { dynamic, relationship, timeline, applied }
}
