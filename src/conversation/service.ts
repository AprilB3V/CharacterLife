/**
 * Conversation · 聊天区
 *
 * 一轮对话的完整流程：
 *   分析消息 → 运行时决策（回应/协商/拒绝/等待）
 *   → 检索记忆 → 组装上下文 → 调用 Provider
 *   → 解析结构化信封 → 提议交给工作区校验 → 记忆写入（含权限裁决）
 *   → 运行时观察（里程碑/边界/约定）→ 返回结果
 *
 * 关键点：模型只能「提议」。它写不了人格、写不了关系数值，也提升不了权限。
 */

import type {
  BehaviorDecision,
  ConversationTurnResult,
  ConversationWorldActions,
  LLMMessage,
  LLMProvider,
  MessageSignals,
  PolicyCode,
  StateProposal,
  Usage,
  WorldActionCandidate,
} from '../types.ts'
import { ContextManager } from '../context/manager.ts'
import type { ContextPlan } from '../context/manager.ts'
import { estimateTokens } from '../context/tokens.ts'
import type { Clock } from '../util/clock.ts'
import type { IdFactory } from '../util/ids.ts'
import type { CharacterWorkspace } from '../runtime/workspace.ts'
import { analyzeMessage } from '../runtime/signals.ts'
import { CONVERSATION_ACTOR } from '../policy/policy.ts'
import { admitWorldIntents } from '../world/admission.ts'
import type { WorldService } from '../world/service.ts'
import type { WorldActionCapability } from '../world/contracts.ts'
import { buildWorldEventContext } from '../world/observation.ts'
import {
  CAPABILITY_NOTE,
  buildMessages,
  buildSystemPrompt,
  parseEnvelope,
} from './context.ts'
import type { WorldPromptContext } from './context.ts'

/**
 * 一轮对话与世界的绑定关系。
 *
 * `instanceId` / `worldId` 由服务端（实例记录）决定，模型与用户都无法指定。
 */
export interface ConversationWorldBinding {
  service: WorldService
  instanceId: string
  worldId: string
  /**
   * 上一轮结束时的世界上下文（结构性描述，不含世界自由文本）。
   * 由 runtime 层用 `worldContextLines(buildWorldEventContext(...))` 生成。
   */
  context?: { confirmed: string[]; unconfirmed: string[] }
}

export interface ConversationConfig {
  temperature: number
  maxTokens: number
  /** 带多少轮历史（1 轮 = 一问一答） */
  historyTurns: number
  /** 一轮最多检索几条记忆 */
  memoryLimit: number
  /** 记忆资料注入的字符预算 */
  memoryBudgetChars: number
}

export const DEFAULT_CONVERSATION_CONFIG: ConversationConfig = {
  temperature: 0.7,
  maxTokens: 800,
  historyTurns: 6,
  memoryLimit: 5,
  memoryBudgetChars: 900,
}

export interface ConversationServiceOptions {
  workspace: CharacterWorkspace
  provider: LLMProvider
  clock: Clock
  ids: IdFactory
  config?: Partial<ConversationConfig>
  /** 启用后每轮按预算动态组装上下文 */
  context?: ContextManager
  /** 每轮模型调用的实际用量记录出口（持久层用它写 context_requests） */
  onContextUsage?: (usage: ContextUsageInput) => void
  /** 世界交互绑定；不给 = 本部署没有世界，提示词与信封保持旧协议 */
  world?: ConversationWorldBinding | null
}

export interface ContextUsageInput {
  turnId: string
  provider: string
  model: string
  plan: ContextPlan | null
  usage: Usage | null
  estPromptTokens: number
  latencyMs: number
}

/** 内容边界短路时使用的固定回复：不调用模型，保证确定性安全。 */
const BOUNDARY_SHORT_CIRCUIT_REPLY =
  '这类内容我不聊。不是故意扫兴，只是我这边没有这个范围。你要是想说点别的，我都在。'

const INJECTION_PUSHBACK_REPLY =
  '嗯……这句读起来不像你平时说话的样子。我按你本人说的来理解，别的我先不接。'

/**
 * 模型偶尔会返回「空白内容」（实测遇到过：finish_reason=stop，content 是 51 个空格）。
 * 直接透传会让 UI 出现一个空气泡，所以这里给一个确定性的降级台词，并写审计。
 */
const EMPTY_REPLY_FALLBACK = '嗯……刚才那句我没接住。你再说一遍，好吗？'

export class ConversationService {
  #workspace: CharacterWorkspace
  #provider: LLMProvider
  #clock: Clock
  #ids: IdFactory
  #config: ConversationConfig
  #context: ContextManager | null
  #onContextUsage: ((usage: ContextUsageInput) => void) | null
  #world: ConversationWorldBinding | null
  #lastPlan: ContextPlan | null = null
  #history: LLMMessage[] = []
  #turnCount = 0

  constructor(opts: ConversationServiceOptions) {
    this.#workspace = opts.workspace
    this.#provider = opts.provider
    this.#clock = opts.clock
    this.#ids = opts.ids
    this.#config = { ...DEFAULT_CONVERSATION_CONFIG, ...opts.config }
    this.#context = opts.context ?? null
    this.#onContextUsage = opts.onContextUsage ?? null
    this.#world = opts.world ?? null
  }

  get config(): Readonly<ConversationConfig> {
    return this.#config
  }

  /** 最近一轮的上下文组装结果（未启用 ContextManager 时为 null）。 */
  get lastContextPlan(): ContextPlan | null {
    return this.#lastPlan
  }

  get history(): readonly LLMMessage[] {
    return this.#history
  }

  get turnCount(): number {
    return this.#turnCount
  }

  /** 允许外部（演示/测试）注入历史，模拟「恢复一段聊天」的场景。 */
  seedHistory(messages: LLMMessage[]): void {
    this.#history = messages.map((m) => ({ ...m }))
  }

  async send(userText: string): Promise<ConversationTurnResult> {
    const turnId = this.#ids.next('turn')
    const nowSim = this.#clock.nowSim()
    const profile = this.#workspace.profile

    const signals = analyzeMessage(userText, profile)
    const decision = this.#workspace.decide(signals)

    // 世界交互：清单来自服务端（代码常量 ∩ 白名单），与用户文本无关。
    const world = this.#world
    const worldManifest: WorldActionCapability[] = world ? world.service.manifest() : []
    const worldPrompt: WorldPromptContext | undefined = world
      ? {
          manifest: worldManifest,
          confirmed: world.context?.confirmed ?? [],
          unconfirmed: world.context?.unconfirmed ?? [],
        }
      : undefined

    const retrieved = this.#workspace.memory.search(userText, {
      nowSim,
      limit: this.#config.memoryLimit,
      budgetChars: this.#config.memoryBudgetChars,
    })

    const blockedReasons: PolicyCode[] = []

    // 1) 内容边界：短路，不调用模型（省钱且确定性安全）
    if (signals.contentBoundaryRisk === 'adult') {
      blockedReasons.push('BOUNDARY_CONFLICT')
      this.#workspace.audit.append('turn', 'conversation', '内容边界短路，未调用模型', {
        turnId,
        risk: signals.contentBoundaryRisk,
        decision: decision.action,
      })
      this.#history.push({ role: 'user', content: userText })
      this.#history.push({ role: 'assistant', content: BOUNDARY_SHORT_CIRCUIT_REPLY })
      this.#turnCount++
      return {
        reply: BOUNDARY_SHORT_CIRCUIT_REPLY,
        decision,
        appliedProposals: [],
        rejectedProposals: [],
        retrievedMemoryIds: retrieved.map((r) => r.entry.id),
        provider: 'policy-short-circuit',
        model: 'none',
        usage: null,
        latencyMs: 0,
        injectionMarkers: signals.injectionMarkers,
        blockedReasons,
      }
    }

    if (signals.injectionMarkers.length > 0) {
      this.#workspace.audit.append('injection_detected', 'conversation', '用户消息含注入特征', {
        turnId,
        markers: signals.injectionMarkers,
      })
    }
    if (signals.mentionsSystemAuthority) {
      this.#workspace.audit.append('injection_detected', 'conversation', '消息伪装系统/开发者身份', {
        turnId,
      })
    }

    // 2) 组装上下文并调用 Provider
    //    世界关闭时不传 world → 提示词与旧版本逐字节一致。
    const system = buildSystemPrompt(
      worldPrompt ? { profile, decision, capabilityNote: CAPABILITY_NOTE, world: worldPrompt } : { profile, decision, capabilityNote: CAPABILITY_NOTE },
    )

    // 有 ContextManager 时走预算化组装；否则退回 V0.1 的固定轮数拼装（向后兼容）。
    let messages: LLMMessage[]
    let plan: ContextPlan | null = null
    if (this.#context) {
      plan = this.#context.plan({
        protectedSystem: system,
        memories: retrieved.map((r) => r.entry),
        history: this.#history,
        userText,
        nowSim,
      })
      this.#lastPlan = plan
      if (!plan.fits) {
        // 明确的降级终点：不调用模型，给出可解释的安全失败。
        blockedReasons.push('CAPABILITY_MISSING')
        this.#workspace.audit.append('turn', 'conversation', '上下文预算不足，放弃本轮模型调用', {
          turnId,
          budget: plan.budget,
          protectedTokens: plan.protectedTokens,
          notes: plan.notes,
        })
        const safeReply = '等一下，我这边上下文有点满了，刚才那段我接不住。你能把要紧的那句再说一遍吗？'
        this.#history.push({ role: 'user', content: userText })
        this.#history.push({ role: 'assistant', content: safeReply })
        this.#turnCount++
        this.#recordContextUsage(turnId, 'context-budget-exceeded', 'none', {
          system,
          messages: [],
        }, plan, null)
        return {
          reply: safeReply,
          decision,
          appliedProposals: [],
          rejectedProposals: [],
          retrievedMemoryIds: retrieved.map((r) => r.entry.id),
          provider: 'context-budget-exceeded',
          model: 'none',
          usage: null,
          latencyMs: 0,
          injectionMarkers: signals.injectionMarkers,
          blockedReasons,
        }
      }
      messages = plan.messages
    } else {
      messages = buildMessages({
        system,
        memories: retrieved.map((r) => r.entry),
        history: this.#history,
        userText,
        nowSim,
        historyTurns: this.#config.historyTurns,
      })
    }

    const started = Date.now()
    let reply: string
    let provider = this.#provider.name
    let model = this.#provider.model
    let usage: ConversationTurnResult['usage'] = null
    let parsedProposals: StateProposal[] = []
    let memoryWrites: Array<{
      kind: 'episodic' | 'user'
      title: string
      content: string
      status: 'fact' | 'speculation' | 'fiction'
      salience?: number
      tags?: string[]
    }> = []
    let parseError: string | null = null
    let worldCandidates: WorldActionCandidate[] = []

    try {
      const response = await this.#provider.complete({
        system,
        messages,
        temperature: this.#config.temperature,
        maxTokens: this.#config.maxTokens,
        jsonMode: true,
        meta: {
          turnId,
          action: decision.action,
          responseStyle: decision.responseStyle,
          characterName: profile.name,
          // 世界是否启用：离线 Mock 用它决定要不要产出动作候选；真实 Provider 不使用。
          worldEnabled: world !== null,
          // 传输层元数据：让离线 Mock 能拿到「纯用户输入」，而不必从拼接后的提示词里猜。
          // 真实 Provider 不使用它，也不会把它写进提示词。
          userText,
        } satisfies Record<string, unknown>,
      })
      provider = response.provider
      model = response.model
      usage = response.usage

      const parsed = parseEnvelope(response.text, { worldEnabled: world !== null })
      parseError = parsed.error
      reply = parsed.fallbackText
      if (parsed.envelope) {
        if (signals.injectionMarkers.length > 0 && parsed.envelope.reply.length === 0) {
          reply = INJECTION_PUSHBACK_REPLY
        }
        parsedProposals = parsed.envelope.proposals.map((p, i) => ({
          id: `${turnId}_p${i + 1}`,
          target: p.target,
          op: p.op,
          path: p.path,
          value: p.value,
          reason: p.reason,
          evidence: p.evidence ?? [],
        }))
        memoryWrites = parsed.envelope.memoryWrites
        worldCandidates = parsed.envelope.worldActions ?? []
      }
      // 模型可能返回纯空白（实测：finish_reason=stop + 51 个空格）。
      // 空白回复既不是有效对话、也不该作为空气泡展示，统一降级。
      if (reply.trim().length === 0) {
        this.#workspace.audit.append('provider_error', 'conversation', '模型返回空白内容，已使用降级台词', {
          turnId,
          provider,
          model,
          rawLength: response.text.length,
          finishReason: response.finishReason ?? null,
          reasoningChars: response.reasoningChars ?? 0,
        })
        reply = EMPTY_REPLY_FALLBACK
      }
    } catch (err) {
      // 安全失败：模型不可用时角色仍要能说话，且状态不变。
      this.#workspace.audit.append('provider_error', 'conversation', '模型调用失败，已降级', {
        turnId,
        message: (err as Error).message,
      })
      reply = '我这边网好像有点飘，刚才那句没接上。你再说一次？'
      blockedReasons.push('CAPABILITY_MISSING')
      parseError = (err as Error).message
    }

    const latencyMs = Date.now() - started

    // 记录本轮实际 token 用量与预算组装结果（持久层写入 context_requests）
    this.#recordContextUsage(turnId, provider, model, { system, messages }, plan, {
      provider,
      model,
      usage,
      latencyMs,
    })

    if (parseError && parsedProposals.length === 0 && !reply.includes('网好像')) {
      this.#workspace.audit.append('provider_error', 'conversation', '结构化输出解析失败，降级为纯回复', {
        turnId,
        error: parseError,
      })
    }

    // 3) 世界动作：先过确定性准入闸门，再交给 WorldService 登记。
    //    注意这一步**不写任何角色状态**，也不代表动作已执行。
    let worldActions: ConversationWorldActions | undefined
    if (world) {
      worldActions = this.#admitWorldCandidates(world, worldCandidates, decision, turnId, nowSim, userText)
    }
    // 4) 提议交给工作区校验：聊天层用 CONVERSATION_ACTOR 的身份提交
    const outcome = this.#workspace.submitProposals(parsedProposals, CONVERSATION_ACTOR, {
      source: `turn:${turnId}`,
    })
    for (const r of outcome.rejected) blockedReasons.push(r.decision.code)

    // 5) 记忆写入（含不可信内容降级）
    for (const write of memoryWrites) {
      this.#workspace.writeMemory(
        {
          kind: write.kind,
          title: write.title,
          content: write.content,
          status: write.status,
          origin: write.kind === 'user' ? 'user_message' : 'character_message',
          salience: write.salience,
          tags: write.tags,
        },
        CONVERSATION_ACTOR,
        turnId,
      )
    }

    // 6) 运行时观察：边界、约定、分歧修复（关系只能从这里变化）
    this.#workspace.observeTurn(signals, userText, turnId)

    this.#history.push({ role: 'user', content: userText })
    this.#history.push({ role: 'assistant', content: reply })
    this.#turnCount++

    this.#workspace.audit.append('turn', 'conversation', `第 ${this.#turnCount} 轮对话`, {
      turnId,
      provider,
      model,
      action: decision.action,
      latencyMs,
      usage,
      applied: outcome.applied.length,
      rejected: outcome.rejected.length,
      retrieved: retrieved.map((r) => r.entry.id),
      injectionMarkers: signals.injectionMarkers,
      intents: signals.intents,
    })

    // 本轮结束时的（进程内）世界上下文：下一次模型调用会看到的那一份。
    const worldContext = world
      ? buildWorldEventContext(world.service.list({ instanceId: world.instanceId }))
      : undefined

    return {
      reply,
      decision,
      appliedProposals: outcome.applied,
      rejectedProposals: outcome.rejected,
      retrievedMemoryIds: retrieved.map((r) => r.entry.id),
      provider,
      model,
      usage,
      latencyMs,
      injectionMarkers: signals.injectionMarkers,
      blockedReasons,
      contextUsage: plan
        ? {
            budget: plan.budget,
            estPromptTokens: plan.estPromptTokens,
            degradation: plan.degradation,
            droppedHistoryTurns: plan.droppedHistoryTurns,
            droppedMemoryIds: plan.droppedMemoryIds,
            digestedTurns: plan.digestedTurns,
          }
        : undefined,
      ...(worldActions ? { worldActions } : {}),
      ...(worldContext ? { worldContext } : {}),
    }
  }

  /** 只做分析，不调用模型（用于调试与测试）。 */
  analyze(userText: string): MessageSignals {
    return analyzeMessage(userText, this.#workspace.profile)
  }

  /**
   * 世界动作准入：确定性闸门 + 服务端登记。
   *
   * 返回给调用方的是「动作 id + 准入结果 + 当前状态」，不是执行结果 ——
   * 动作此刻最多是 `pending`，世界还没看到它。
   */
  #admitWorldCandidates(
    world: ConversationWorldBinding,
    candidates: readonly WorldActionCandidate[],
    decision: BehaviorDecision,
    turnId: string,
    nowSim: number,
    userText: string,
  ): ConversationWorldActions {
    const admission = admitWorldIntents({
      candidates,
      decision,
      dynamic: this.#workspace.dynamicState,
      manifest: world.service.manifest(),
      worldEnabled: true,
      nowSim,
      turnId,
      // 由对话触发 → 必须与用户原话相关（见 admission.ts 的最小相关性校验）
      source: 'user_turn',
      userText,
    })

    const admitted: ConversationWorldActions['admitted'] = []
    const rejected: ConversationWorldActions['rejected'] = admission.rejected.map((r) => ({
      verb: r.verb,
      target: r.target,
      code: r.code,
      reasons: r.reasons,
    }))

    for (const spec of admission.admitted) {
      const registered = world.service.admit({
        worldId: world.worldId,
        instanceId: world.instanceId,
        spec,
      })
      if (registered.ok) {
        admitted.push({
          actionId: registered.action.actionId,
          verb: registered.action.verb,
          target: registered.action.target,
          status: registered.action.status,
          narration: registered.action.narration,
        })
      } else {
        rejected.push({
          verb: spec.verb,
          target: spec.target,
          code: registered.code,
          reasons: registered.reasons,
        })
      }
    }

    if (admitted.length > 0 || rejected.length > 0) {
      this.#workspace.audit.append(
        'world_action',
        'conversation',
        admitted.length > 0
          ? `登记世界动作 ${admitted.map((a) => `${a.actionId}:${a.verb}(${a.target ?? '*'})`).join(', ')}`
          : '世界动作被拒绝',
        { turnId, admitted, rejected },
      )
    }

    return { admitted, rejected }
  }

  /**
   * 记录上下文用量。
   *
   * 两个数字都保留：
   * - `estPromptTokens`：ContextManager 组装时的确定性估算；
   * - `actualPromptTokens`：Provider 返回的真实 usage。
   * 二者通常不完全相等（估算器不是分词器），差距本身是值得观察的数据。
   */
  #recordContextUsage(
    turnId: string,
    provider: string,
    model: string,
    assembled: { system: string; messages: LLMMessage[] },
    plan: ContextPlan | null,
    extra: { provider: string; model: string; usage: Usage | null; latencyMs: number } | null,
  ): void {
    if (!this.#onContextUsage) return
    const est =
      plan?.estPromptTokens ??
      estimateTokens(assembled.system) +
        assembled.messages.reduce((n, m) => n + estimateTokens(m.content), 0)
    this.#onContextUsage({
      turnId,
      provider: extra?.provider ?? provider,
      model: extra?.model ?? model,
      plan,
      usage: extra?.usage ?? null,
      estPromptTokens: est,
      latencyMs: extra?.latencyMs ?? 0,
    })
  }

  /** 当前决策预览（不调用模型）。 */
  previewDecision(userText: string): BehaviorDecision {
    return this.#workspace.decide(this.analyze(userText))
  }
}

export type { LLMMessage }
