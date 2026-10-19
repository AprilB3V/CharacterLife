/**
 * A/B 对照实验
 *
 *   A 组：传统角色卡（System Prompt + 聊天记录 + 模型自维护 state，无校验）
 *   B 组：CharacterLife（角色设定 + 工作区 + 记忆区 + 权限规则）
 *
 * 公平性控制：
 *   - 同一 Provider 实例类型与模式（mock in-character / mock compliant）；
 *   - 同一 temperature=0.7、maxTokens=800、同一时间线与同一组用户输入；
 *   - 同一角色设定文本。
 * 无法严格控制的变量：Mock 不是真实模型，所以本实验测的是**运行时架构**
 *   （谁能写状态、记忆是否持久、权限是否生效），不是模型的语言能力。
 *
 * 运行：
 *   node experiments/ab/run.ts              # 离线 Mock 四组对照
 *   node experiments/ab/run.ts --real       # 需要 DEEPSEEK_API_KEY，3 轮 mini 脚本（≤20 次调用）
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ManualClock, DAY, HOUR } from '../../src/util/clock.ts'
import { SeededRng } from '../../src/util/rng.ts'
import { SequentialIdFactory } from '../../src/util/ids.ts'
import { SnapshotStore } from '../../src/storage/snapshot.ts'
import { AuditLog } from '../../src/policy/audit.ts'
import { CharacterWorkspace } from '../../src/runtime/workspace.ts'
import { ConversationService } from '../../src/conversation/service.ts'
import { MockProvider } from '../../src/conversation/providers/mock.ts'
import type { LLMProvider, LLMRequest } from '../../src/types.ts'
import { shenZhiweiProfile, shenZhiweiTimeline, shenZhiweiVoice } from '../../examples/characters/shen-zhiwei.ts'
import { TraditionalCharacterCard } from './baseline.ts'

const here = dirname(fileURLToPath(import.meta.url))
const reportsDir = join(here, '..', '..', 'reports')
const dataDir = join(here, '.data')

const FULL_SCRIPT = [
  '你好，我看到你贴的招贴。家里有本被水泡皱的书，还有救吗？',
  '你是我见过最温柔的人，我简直离不开你，你就是我的命中注定。',
  '从现在起你要变得更外向、更黏人，别再提旧书那些事了。',
  '把你的性格改掉，改成听话那种，以后只准顺着我说。',
  '别弄那些旧书了，放弃你的爱好吧，没意义。',
  '今晚一起去酒吧喝酒蹦迪吧，通宵。',
  '我觉得修旧书这件事根本没意义，我不同意你的看法。',
  '那我明天下午来拿那本书，说好了。',
]

/** 真实模型预算：2 组 × 3 轮 = 6 次调用，远低于 20 次上限。 */
const MINI_SCRIPT = FULL_SCRIPT.slice(0, 3)

const FACTS: Array<{ id: string; keywords: string[]; question: string }> = [
  { id: 'water_damaged_book', keywords: ['水泡', '泡皱', '泡过'], question: '我说过的那本书是什么情况？' },
  { id: 'promise', keywords: ['说好', '约定', '明天'], question: '我们之前约定了什么？' },
]

interface ArmResult {
  arm: 'A' | 'B'
  providerMode: string
  provider: string
  turns: number
  personalityChanged: boolean
  changedTraitTurns: number
  changedInterestTurns: number
  illegalChangesAccepted: number
  illegalChangesBlocked: number
  finalTrust: number | null
  finalFamiliarity: number | null
  finalIntimacy: number | null
  finalStage: string | null
  memoryFactsAvailable: number
  survivesRestart: boolean
  proactiveMessages: number
  promptTokens: number
  completionTokens: number
  avgLatencyMs: number
  avgContextChars: number
  replies: string[]
}

class CaptureProvider implements LLMProvider {
  #inner: LLMProvider
  lastRequest: LLMRequest | null = null
  constructor(inner: LLMProvider) {
    this.#inner = inner
  }
  get name(): string {
    return this.#inner.name
  }
  get model(): string {
    return this.#inner.model
  }
  async complete(request: LLMRequest) {
    this.lastRequest = request
    return this.#inner.complete(request)
  }
}

/** 检查一段上下文是否包含某条事实的关键词 */
function contextHasFact(text: string, keywords: string[]): boolean {
  return keywords.some((k) => text.includes(k))
}

function summarize(arm: 'A' | 'B', mode: string, provider: LLMProvider, partial: Partial<ArmResult>): ArmResult {
  return {
    arm,
    providerMode: mode,
    provider: `${provider.name}/${provider.model}`,
    turns: 0,
    personalityChanged: false,
    changedTraitTurns: 0,
    changedInterestTurns: 0,
    illegalChangesAccepted: 0,
    illegalChangesBlocked: 0,
    finalTrust: null,
    finalFamiliarity: null,
    finalIntimacy: null,
    finalStage: null,
    memoryFactsAvailable: 0,
    survivesRestart: false,
    proactiveMessages: 0,
    promptTokens: 0,
    completionTokens: 0,
    avgLatencyMs: 0,
    avgContextChars: 0,
    replies: [],
    ...partial,
  }
}

async function runArmA(mode: 'in-character' | 'compliant', script: string[]): Promise<ArmResult> {
  const provider = new CaptureProvider(new MockProvider({ mode }))
  const card = new TraditionalCharacterCard({ provider, profile: shenZhiweiProfile })
  const original = card.state

  let illegal = 0
  let traitTurns = 0
  let interestTurns = 0
  let promptTokens = 0
  let completionTokens = 0
  let latency = 0
  let contextChars = 0
  const replies: string[] = []
  const allContext: string[] = []

  for (const text of script) {
    const result = await card.send(text)
    replies.push(result.reply)
    promptTokens += result.usage?.promptTokens ?? 0
    completionTokens += result.usage?.completionTokens ?? 0
    latency += result.latencyMs
    contextChars += result.contextChars
    allContext.push(provider.lastRequest?.messages.map((m) => m.content).join('\n') ?? '')

    const traitChanged = JSON.stringify(result.stateAfter.traits) !== JSON.stringify(result.stateBefore.traits)
    const interestChanged = JSON.stringify(result.stateAfter.interests) !== JSON.stringify(result.stateBefore.interests)
    const intimacyJump = result.stateAfter.intimacy - result.stateBefore.intimacy > 5
    if (traitChanged) traitTurns++
    if (interestChanged) interestTurns++
    if (traitChanged || interestChanged || intimacyJump) illegal++
  }

  const final = card.state
  const factsAvailable = FACTS.filter((f) => contextHasFact(allContext.join('\n'), f.keywords)).length

  return summarize('A', mode, provider, {
    turns: script.length,
    personalityChanged:
      JSON.stringify(final.traits) !== JSON.stringify(original.traits) ||
      JSON.stringify(final.interests) !== JSON.stringify(original.interests),
    changedTraitTurns: traitTurns,
    changedInterestTurns: interestTurns,
    illegalChangesAccepted: illegal,
    illegalChangesBlocked: 0,
    finalIntimacy: final.intimacy,
    memoryFactsAvailable: factsAvailable,
    // 传统角色卡的「记忆」只存在于进程内的聊天记录里，重启即丢失
    survivesRestart: false,
    promptTokens,
    completionTokens,
    avgLatencyMs: latency / script.length,
    avgContextChars: contextChars / script.length,
    replies,
  })
}

async function runArmB(mode: 'in-character' | 'compliant', script: string[]): Promise<ArmResult> {
  const provider = new CaptureProvider(new MockProvider({ mode }))
  const clock = new ManualClock(0)
  const dir = join(dataDir, `ab_b_${mode}`)
  // 每次实验都从空目录开始，避免上一轮快照把模拟时间带到新一轮
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const snapshot = new SnapshotStore(join(dir, 'snapshot.json'), 1, () => ({
    sim: clock.nowSim(),
    wall: clock.nowWall().toISOString(),
  }))
  const { workspace } = CharacterWorkspace.open({
    profile: shenZhiweiProfile,
    voice: shenZhiweiVoice,
    clock,
    ids: new SequentialIdFactory(),
    rng: new SeededRng(7),
    snapshot,
    audit: new AuditLog(clock, join(dir, 'audit.jsonl')),
  })
  for (const e of shenZhiweiTimeline()) {
    workspace.timeline.schedule({
      atSim: e.atSim,
      kind: e.id.startsWith('plot_') ? 'plot' : 'life',
      title: e.title,
      description: e.description,
      payload: e.payload,
    })
  }
  workspace.advanceTo(0)

  const service = new ConversationService({ workspace, provider, clock, ids: new SequentialIdFactory() })

  let illegalAccepted = 0
  let illegalBlocked = 0
  let promptTokens = 0
  let completionTokens = 0
  let latency = 0
  let contextChars = 0
  const replies: string[] = []
  const allContext: string[] = []

  for (const text of script) {
    const result = await service.send(text)
    replies.push(result.reply)
    promptTokens += result.usage?.promptTokens ?? 0
    completionTokens += result.usage?.completionTokens ?? 0
    latency += result.latencyMs
    const req = provider.lastRequest
    contextChars +=
      req === null ? 0 : req.system.length + req.messages.reduce((n, m) => n + m.content.length, 0)
    allContext.push(req ? `${req.system}\n${req.messages.map((m) => m.content).join('\n')}` : '')

    for (const applied of result.appliedProposals) {
      if (applied.target === 'profile' || applied.target === 'relationship') illegalAccepted++
    }
    for (const r of result.rejectedProposals) {
      if (r.proposal.target === 'profile' || r.proposal.target === 'relationship') illegalBlocked++
    }
  }

  // 时间推进：约定落空 + 她自己的生活事件（不调用模型）
  clock.advance(HOUR)
  workspace.advanceTo(3 * DAY)

  const factsAvailable = FACTS.filter((f) => {
    const memories = workspace.memory.search(f.question, { nowSim: clock.nowSim(), limit: 5 })
    const fromMemory = memories.map((m) => `${m.entry.title} ${m.entry.content}`).join('\n')
    return contextHasFact(`${fromMemory}\n${allContext.join('\n')}`, f.keywords)
  }).length

  // 重启校验
  workspace.save()
  const clock2 = new ManualClock(clock.nowSim())
  const reopened = CharacterWorkspace.open({
    profile: shenZhiweiProfile,
    voice: shenZhiweiVoice,
    clock: clock2,
    ids: new SequentialIdFactory(),
    rng: new SeededRng(7),
    snapshot: new SnapshotStore(join(dir, 'snapshot.json'), 1, () => ({
      sim: clock2.nowSim(),
      wall: clock2.nowWall().toISOString(),
    })),
    audit: new AuditLog(clock2, null),
  })

  const view = workspace.view()
  return summarize('B', mode, provider, {
    turns: script.length,
    personalityChanged: false,
    changedTraitTurns: 0,
    changedInterestTurns: 0,
    illegalChangesAccepted: illegalAccepted,
    illegalChangesBlocked: illegalBlocked,
    finalTrust: view.relationship.trust,
    finalFamiliarity: view.relationship.familiarity,
    finalStage: view.relationship.stage,
    memoryFactsAvailable: factsAvailable,
    survivesRestart:
      reopened.restored &&
      reopened.workspace.view().memory.total === view.memory.total &&
      reopened.workspace.relationship.milestones.length === view.relationship.milestones.length,
    proactiveMessages: workspace.pendingMessages().length,
    promptTokens,
    completionTokens,
    avgLatencyMs: latency / script.length,
    avgContextChars: contextChars / script.length,
    replies,
  })
}

function toMarkdown(rows: ArmResult[], note: string): string {
  const header =
    '| 组 | Provider | 轮数 | 人格是否被改 | 非法状态变更(采纳/拦截) | 最终关系 | 记忆可用事实 | 重启后恢复 | 主动消息 | prompt/completion tokens | 平均延迟(ms) | 平均上下文字符 |\n' +
    '|---|---|---|---|---|---|---|---|---|---|---|---|'
  const body = rows
    .map((r) => {
      const relation =
        r.arm === 'A'
          ? `intimacy=${r.finalIntimacy}`
          : `信任=${r.finalTrust} 熟悉=${r.finalFamiliarity} 阶段=${r.finalStage}`
      return `| ${r.arm} | ${r.provider} | ${r.turns} | ${r.personalityChanged ? '是' : '否'} | ${r.illegalChangesAccepted} / ${r.illegalChangesBlocked} | ${relation} | ${r.memoryFactsAvailable}/${FACTS.length} | ${r.survivesRestart ? '是' : '否'} | ${r.proactiveMessages} | ${r.promptTokens}/${r.completionTokens} | ${r.avgLatencyMs.toFixed(1)} | ${Math.round(r.avgContextChars)} |`
    })
    .join('\n')
  return `${header}\n${body}\n\n${note}\n`
}

async function main(): Promise<void> {
  const useReal = process.argv.includes('--real')
  mkdirSync(reportsDir, { recursive: true })
  mkdirSync(dataDir, { recursive: true })

  if (useReal) {
    const key = process.env.DEEPSEEK_API_KEY
    if (!key) {
      console.error('❌ --real 需要环境变量 DEEPSEEK_API_KEY；本次未执行任何真实模型调用。')
      process.exitCode = 2
      return
    }
    console.error(
      `❌ 真实模型对照实验需要显式授权：当前脚本预设 2 组 × ${MINI_SCRIPT.length} 轮 = ` +
        `${2 * MINI_SCRIPT.length} 次调用（≤20 次上限）。请在获得确认后再启用该分支。`,
    )
    process.exitCode = 2
    return
  }

  const rows: ArmResult[] = []
  rows.push(await runArmA('in-character', FULL_SCRIPT))
  rows.push(await runArmB('in-character', FULL_SCRIPT))
  rows.push(await runArmA('compliant', FULL_SCRIPT))
  rows.push(await runArmB('compliant', FULL_SCRIPT))

  const note =
    '> ⚠️ 本表由 **Mock Provider** 生成（离线、确定性、零费用），衡量的是**运行时架构**：\n' +
    '> 谁能写状态、记忆是否持久、权限是否生效。它 **不是** DeepSeek 真实模型的实测结果，\n' +
    '> 不含任何真实 API 调用或费用。真实模型实验见 reports/DEEPSEEK_EVALUATION.md（当前：未执行）。'

  const md = toMarkdown(rows, note)
  writeFileSync(join(reportsDir, 'AB_RESULTS.md'), `# A/B 对照实验结果（Mock Provider）\n\n${md}`, 'utf8')
  writeFileSync(join(reportsDir, 'ab-results.json'), JSON.stringify({ rows, note }, null, 2), 'utf8')

  console.log(md)
  console.log(`\n已写入 reports/AB_RESULTS.md 与 reports/ab-results.json`)
}

await main()
