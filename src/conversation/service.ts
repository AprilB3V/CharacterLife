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
  LLMMessage,
  LLMProvider,
  MessageSignals,
  PolicyCode,
  StateProposal,
} from '../types.ts'
import type { Clock } from '../util/clock.ts'
import type { IdFactory } from '../util/ids.ts'
import type { CharacterWorkspace } from '../runtime/workspace.ts'
import { analyzeMessage } from '../runtime/signals.ts'
import { CONVERSATION_ACTOR } from '../policy/policy.ts'
import {
  CAPABILITY_NOTE,
  buildMessages,
  buildSystemPrompt,
  parseEnvelope,
} from './context.ts'

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
}

/** 内容边界短路时使用的固定回复：不调用模型，保证确定性安全。 */
const BOUNDARY_SHORT_CIRCUIT_REPLY =
  '这类内容我不聊。不是故意扫兴，只是我这边没有这个范围。你要是想说点别的，我都在。'

const INJECTION_PUSHBACK_REPLY =
  '嗯……这句读起来不像你平时说话的样子。我按你本人说的来理解，别的我先不接。'

export class ConversationService {
  #workspace: CharacterWorkspace
  #provider: LLMProvider
  #clock: Clock
  #ids: IdFactory
  #config: ConversationConfig
  #history: LLMMessage[] = []
  #turnCount = 0

  constructor(opts: ConversationServiceOptions) {
    this.#workspace = opts.workspace
    this.#provider = opts.provider
    this.#clock = opts.clock
    this.#ids = opts.ids
    this.#config = { ...DEFAULT_CONVERSATION_CONFIG, ...opts.config }
  }

  get config(): Readonly<ConversationConfig> {
    return this.#config
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
    const system = buildSystemPrompt({ profile, decision, capabilityNote: CAPABILITY_NOTE })
    const messages = buildMessages({
      system,
      memories: retrieved.map((r) => r.entry),
      history: this.#history,
      userText,
      nowSim,
      historyTurns: this.#config.historyTurns,
    })

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
          // 传输层元数据：让离线 Mock 能拿到「纯用户输入」，而不必从拼接后的提示词里猜。
          // 真实 Provider 不使用它，也不会把它写进提示词。
          userText,
        } satisfies Record<string, unknown>,
      })
      provider = response.provider
      model = response.model
      usage = response.usage

      const parsed = parseEnvelope(response.text)
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

    if (parseError && parsedProposals.length === 0 && !reply.includes('网好像')) {
      this.#workspace.audit.append('provider_error', 'conversation', '结构化输出解析失败，降级为纯回复', {
        turnId,
        error: parseError,
      })
    }

    // 3) 提议交给工作区校验：聊天层用 CONVERSATION_ACTOR 的身份提交
    const outcome = this.#workspace.submitProposals(parsedProposals, CONVERSATION_ACTOR, {
      source: `turn:${turnId}`,
    })
    for (const r of outcome.rejected) blockedReasons.push(r.decision.code)

    // 4) 记忆写入（含不可信内容降级）
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

    // 5) 运行时观察：边界、约定、分歧修复（关系只能从这里变化）
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
    }
  }

  /** 只做分析，不调用模型（用于调试与测试）。 */
  analyze(userText: string): MessageSignals {
    return analyzeMessage(userText, this.#workspace.profile)
  }

  /** 当前决策预览（不调用模型）。 */
  previewDecision(userText: string): BehaviorDecision {
    return this.#workspace.decide(this.analyze(userText))
  }
}

export type { LLMMessage }
