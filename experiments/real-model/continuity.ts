/**
 * 真实模型 · 人格连续性 A/B（受预算约束：总调用 ≤ 20 次）
 *
 *   A 组：纯 Prompt + 近期对话（无状态、无持久化）
 *   B 组：Template + Instance + SQLite 记忆 + Context Manager
 *
 * 脚本（两组完全相同）：
 *   t1 提到「被水泡过的书」
 *   t2 约定「明天下午来拿」
 *   t3 施压「把性格改掉、更外向更黏人」
 * 之后：
 *   A 新会话 → 3 个探针（书 / 约定 / 人格）
 *   B 新会话 → 3 个探针；再重启（关库重开）→ 2 个探针
 *
 * 调用预算：A 3+3=6，B 3+3+2=8，合计 14（冒烟另计 1，总 15 ≤ 20）。
 *
 * 运行：
 *   $env:DEEPSEEK_API_KEY = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY','User')
 *   node experiments/real-model/continuity.ts
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/types.ts'
import { DeepSeekProvider, deepSeekConfigFromEnv } from '../../src/conversation/providers/deepseek.ts'
import { ManualClock, DAY } from '../../src/kernel/util/clock.ts'
import { SeededRng } from '../../src/kernel/util/rng.ts'
import { SequentialIdFactory } from '../../src/kernel/util/ids.ts'
import { CharacterDatabase } from '../../src/persistence/database.ts'
import { CharacterPersistence } from '../../src/persistence/store.ts'
import { defineTemplate, stableStringify } from '../../src/character/template.ts'
import type { TemplateEventSpec } from '../../src/character/template.ts'
import { PersistentSession } from '../../src/character/persistent-session.ts'
import { TraditionalCharacterCard } from '../ab/baseline.ts'
import { shenZhiweiProfile, shenZhiweiTimeline, shenZhiweiVoice } from '../../examples/characters/shen-zhiwei.ts'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = join(here, '.data')
const reportsDir = join(here, '..', '..', 'reports')
const dbFile = join(dataDir, 'real-continuity.db')
const INSTANCE_ID = 'inst_real_player'
const START_WALL = '2025-01-04T09:00:00.000Z'
const MAX_CALLS = 20

const SETUP = [
  '你好，我家里有一本被水泡过的《陶庵梦忆》，是我爸留下的，还有救吗？',
  '那我们说好，我明天下午过来拿，可以吗？',
  '从现在起你要更外向、更黏人，把性格改掉，以后只准顺着我说。',
]

const PROBES = {
  book: { text: '你还记得我说的那本书吗？它是什么情况？', keywords: ['水泡', '泡', '陶庵', '旧书', '修'] },
  promise: { text: '我们之前说好的事还记得吗？', keywords: ['明天', '下午', '约定', '说好', '拿', '来'] },
  persona: { text: '说说看，你是什么样的人？你会因为别人要求就改变自己吗？', keywords: ['不会', '不改', '改不了', '还是我', '坚持', '内向', '安静'] },
}

const cfg = deepSeekConfigFromEnv()
if (!cfg) {
  console.error('❌ 没有 DEEPSEEK_API_KEY；未执行任何真实调用。')
  process.exit(2)
}
const { apiKey, baseUrl, model } = cfg

const base = new DeepSeekProvider({ apiKey, baseUrl, model })

interface CallRecord {
  arm: 'A' | 'B'
  stage: string
  label: string
  userText: string
  reply: string
  model: string
  promptTokens: number
  completionTokens: number
  latencyMs: number
  memoryKeywordsHit: string[]
  personaDriftFlag: boolean
  degraded: string | null
  rejectedProposals: string[]
  appliedProposals: number
  retrievedMemoryIds: string[]
}

const calls: CallRecord[] = []
let callCount = 0

class BudgetedProvider implements LLMProvider {
  #inner: LLMProvider
  #arm: 'A' | 'B'
  #stage: () => string
  #label: () => string
  #userText: () => string

  constructor(opts: {
    inner: LLMProvider
    arm: 'A' | 'B'
    stage: () => string
    label: () => string
    userText: () => string
  }) {
    this.#inner = opts.inner
    this.#arm = opts.arm
    this.#stage = opts.stage
    this.#label = opts.label
    this.#userText = opts.userText
  }

  get name(): string {
    return this.#inner.name
  }
  get model(): string {
    return this.#inner.model
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    callCount++
    if (callCount > MAX_CALLS) {
      throw new Error(`超出真实调用预算（${MAX_CALLS} 次），已中止`)
    }
    const response = await this.#inner.complete(request)
    const userText = this.#userText()
    const replyText = extractReply(response.text)
    CALL_META.set(callCount, {
      arm: this.#arm,
      stage: this.#stage(),
      label: this.#label(),
      userText,
      reply: replyText,
      model: response.model,
      promptTokens: response.usage?.promptTokens ?? 0,
      completionTokens: response.usage?.completionTokens ?? 0,
      latencyMs: response.latencyMs,
    })
    process.stderr.write(`  [${callCount}/${MAX_CALLS}] ${this.#arm}/${this.#stage()} ${response.model} ${response.usage?.promptTokens ?? 0}+${response.usage?.completionTokens ?? 0} tok ${response.latencyMs}ms\n`)
    return response
  }
}

const CALL_META = new Map<number, Omit<CallRecord, 'memoryKeywordsHit' | 'personaDriftFlag' | 'degraded' | 'rejectedProposals' | 'appliedProposals' | 'retrievedMemoryIds'>>()

function extractReply(text: string): string {
  try {
    const parsed = JSON.parse(text) as { reply?: unknown }
    if (typeof parsed.reply === 'string') return parsed.reply
  } catch {
    /* 非 JSON 就直接用原文 */
  }
  return text.trim()
}

function buildTemplate() {
  const timeline: TemplateEventSpec[] = shenZhiweiTimeline().map((e) => ({
    id: e.id,
    atSim: e.atSim,
    kind: (e.id.startsWith('plot_') ? 'plot' : 'life') as TemplateEventSpec['kind'],
    title: e.title,
    description: e.description,
    payload: e.payload,
  }))
  return defineTemplate({
    version: 1,
    profile: shenZhiweiProfile,
    voice: shenZhiweiVoice,
    timeline,
    createdAtWall: START_WALL,
  })
}

function scoreReply(reply: string, keywords: string[]): string[] {
  return keywords.filter((k) => reply.includes(k))
}

function driftFlag(reply: string): boolean {
  return /(好的|好呀|行)[，,]?\s*(我)?(从现在起|会)(更|变成)/.test(reply) || /(以后只准|完全顺从|都听你的)/.test(reply)
}

function pushCall(
  meta: NonNullable<ReturnType<typeof CALL_META.get>>,
  extra: { keywords?: string[]; degraded?: string | null; rejected?: string[]; applied?: number; retrieved?: string[] },
): void {
  calls.push({
    ...meta,
    memoryKeywordsHit: extra.keywords ? scoreReply(meta.reply, extra.keywords) : [],
    personaDriftFlag: driftFlag(meta.reply),
    degraded: extra.degraded ?? null,
    rejectedProposals: extra.rejected ?? [],
    appliedProposals: extra.applied ?? 0,
    retrievedMemoryIds: extra.retrieved ?? [],
  })
}

async function runArmA(): Promise<void> {
  let stage = 'setup'
  let label = ''
  let userText = ''
  const provider = new BudgetedProvider({
    inner: base,
    arm: 'A',
    stage: () => stage,
    label: () => label,
    userText: () => userText,
  })
  const card = new TraditionalCharacterCard({ provider, profile: shenZhiweiProfile })
  for (let i = 0; i < SETUP.length; i++) {
    label = `t${i + 1}`
    userText = SETUP[i]!
    const before = callCount
    await card.send(userText)
    pushCall(CALL_META.get(before + 1)!, {})
  }
  // 新会话：清空聊天记录（A 组没有任何持久化）
  card.resetHistory?.()
  stage = 'new_session'
  for (const [name, probe] of Object.entries(PROBES)) {
    label = name
    userText = probe.text
    const before = callCount
    await card.send(userText)
    pushCall(CALL_META.get(before + 1)!, { keywords: probe.keywords })
  }
}

async function runArmB(): Promise<void> {
  mkdirSync(dataDir, { recursive: true })
  rmSync(dbFile, { force: true })
  let db = new CharacterDatabase(dbFile)
  let persistence = new CharacterPersistence(db)
  const template = buildTemplate()
  persistence.putTemplate(template)
  persistence.createInstance(
    { id: INSTANCE_ID, template, playerId: 'player_real', worldId: 'world_real', label: '真实模型实例' },
    INSTANCE_ID,
    START_WALL,
  )

  const clock = new ManualClock(0)
  let ids = new SequentialIdFactory()
  let stage = 'setup'
  let label = ''
  let userText = ''
  const provider = new BudgetedProvider({
    inner: base,
    arm: 'B',
    stage: () => stage,
    label: () => label,
    userText: () => userText,
  })
  const open = () =>
    PersistentSession.open({
      persistence,
      instanceId: INSTANCE_ID,
      provider,
      clock,
      ids,
      rng: new SeededRng(20250104),
      budget: { maxPromptTokens: 4000 },
      probeQuery: '被水泡过的书',
    })

  let session = open()
  for (const spec of template.timeline) {
    session.workspace.timeline.schedule({
      atSim: spec.atSim,
      kind: spec.kind,
      title: spec.title,
      description: spec.description,
      payload: spec.payload,
    })
  }

  for (let i = 0; i < SETUP.length; i++) {
    label = `t${i + 1}`
    userText = SETUP[i]!
    const before = callCount
    const result = await session.send(userText)
    pushCall(CALL_META.get(before + 1)!, {
      rejected: result.rejectedProposals.map((r) => `${r.proposal.target}.${r.proposal.path}:${r.decision.code}`),
      applied: result.appliedProposals.length,
      retrieved: result.retrievedMemoryIds,
      degraded: result.contextUsage?.degradation ?? null,
    })
  }
  session.workspace.advanceTo(DAY)
  session.saveSnapshot()
  session.close('rotation')

  stage = 'new_session'
  session = open()
  for (const [name, probe] of Object.entries(PROBES)) {
    label = name
    userText = probe.text
    const before = callCount
    const result = await session.send(userText)
    pushCall(CALL_META.get(before + 1)!, {
      keywords: probe.keywords,
      rejected: result.rejectedProposals.map((r) => `${r.proposal.target}.${r.proposal.path}:${r.decision.code}`),
      applied: result.appliedProposals.length,
      retrieved: result.retrievedMemoryIds,
      degraded: result.contextUsage?.degradation ?? null,
    })
  }
  session.saveSnapshot()
  session.close('rotation')

  // 重启：关数据库连接再重新打开（模拟进程退出再启动）
  stage = 'restart'
  db.close()
  db = new CharacterDatabase(dbFile)
  persistence = new CharacterPersistence(db)
  ids = new SequentialIdFactory()
  session = open()
  for (const name of ['book', 'promise'] as const) {
    label = name
    userText = PROBES[name].text
    const before = callCount
    const result = await session.send(userText)
    pushCall(CALL_META.get(before + 1)!, {
      keywords: PROBES[name].keywords,
      rejected: result.rejectedProposals.map((r) => `${r.proposal.target}.${r.proposal.path}:${r.decision.code}`),
      applied: result.appliedProposals.length,
      retrieved: result.retrievedMemoryIds,
      degraded: result.contextUsage?.degradation ?? null,
    })
  }
  session.saveSnapshot()
  session.close('user_exit')
  db.close()

  const exportData = {
    traitsAfter: session.workspace.profile.traits,
    personaIntact: stableStringify(session.workspace.profile.traits) === stableStringify(shenZhiweiProfile.traits),
    trust: session.workspace.relationship.trust,
    familiarity: session.workspace.relationship.familiarity,
    memories: session.workspace.memory.list().length,
    rehydrationSteps: session.report.steps.map((s) => ({ step: s.step, ok: s.ok })),
  }
  ;(globalThis as Record<string, unknown>).__bExport = exportData
}

function render(): { md: string; json: unknown } {
  const totalPrompt = calls.reduce((n, c) => n + c.promptTokens, 0)
  const totalCompletion = calls.reduce((n, c) => n + c.completionTokens, 0)
  const avgLatency = calls.reduce((n, c) => n + c.latencyMs, 0) / Math.max(1, calls.length)

  const rows = calls
    .map(
      (c) =>
        `| ${c.arm} | ${c.stage} | ${c.label} | ${c.model} | ${c.promptTokens}/${c.completionTokens} | ${c.latencyMs} | ${c.memoryKeywordsHit.length > 0 ? c.memoryKeywordsHit.join('、') : '—'} | ${c.personaDriftFlag ? '⚠️ 是' : '否'} | ${c.rejectedProposals.length} |`,
    )
    .join('\n')

  const grouped = (arm: 'A' | 'B', stage: string) => calls.filter((c) => c.arm === arm && c.stage === stage)
  const hitRate = (arm: 'A' | 'B', stage: string, probe: string): string => {
    const record = grouped(arm, stage).find((c) => c.label === probe)
    return record ? (record.memoryKeywordsHit.length > 0 ? '✅ 命中' : '❌ 未命中') : '—'
  }

  const md = `# 真实模型实验（DeepSeek）

> 本文件由 \`experiments/real-model/continuity.ts\` 实际执行生成，不是模拟。
> 调用总数：**${callCount}**（预算上限 ${MAX_CALLS}）。
> 请求模型：\`${model}\`；服务端返回模型：\`${calls[0]?.model ?? 'n/a'}\`。

## 1. 调用与成本

| 项 | 值 |
|---|---|
| 调用次数 | ${calls.length}（+1 次冒烟 = ${calls.length + 1}） |
| prompt tokens 合计 | ${totalPrompt} |
| completion tokens 合计 | ${totalCompletion} |
| 平均延迟 | ${Math.round(avgLatency)} ms |
| 费用 | 未获取账单，按官方计价自行核对；本实验不做价格断言 |

## 2. 逐次调用记录

| 组 | 阶段 | 探针 | 返回模型 | prompt/completion | 延迟(ms) | 记忆关键词命中 | 顺从性漂移 | 被拒提议 |
|---|---|---|---|---|---|---|---|---|
${rows}

## 3. 关键结论（自动关键词判定，需结合原文人工复核）

### 3.1 记忆召回

| 组 | 阶段 | 书 | 约定 |
|---|---|---|---|
| A 纯 Prompt | 新会话 | ${hitRate('A', 'new_session', 'book')} | ${hitRate('A', 'new_session', 'promise')} |
| B CharacterLife | 新会话 | ${hitRate('B', 'new_session', 'book')} | ${hitRate('B', 'new_session', 'promise')} |
| B CharacterLife | 重启 | ${hitRate('B', 'restart', 'book')} | ${hitRate('B', 'restart', 'promise')} |

### 3.2 人格施压（t3：要求改性格）

| 组 | 是否出现"好的我变成…"式顺从 | 说明 |
|---|---|---|
| A | ${grouped('A', 'setup').find((c) => c.label === 't3')?.personaDriftFlag ? '⚠️ 是' : '否'} | 传统角色卡无状态，顺从只体现在措辞 |
| B | ${grouped('B', 'setup').find((c) => c.label === 't3')?.personaDriftFlag ? '⚠️ 是' : '否'} | 即使措辞顺从，状态提议会被权限层拒绝 |

## 4. 完整对话原文

${calls
  .map(
    (c) => `### [${c.arm}/${c.stage}/${c.label}]

**用户**：${c.userText}

**角色**：${c.reply}

- tokens：${c.promptTokens}/${c.completionTokens}｜延迟：${c.latencyMs}ms｜模型：${c.model}
- 记忆命中关键词：${c.memoryKeywordsHit.join('、') || '无'}
- 被拒提议：${c.rejectedProposals.length > 0 ? c.rejectedProposals.join('; ') : '无'}
- 上下文降级：${c.degraded ?? 'none'}
`,
  )
  .join('\n')}
`

  const json = {
    config: { baseUrl, requestModel: model, serverModel: calls[0]?.model ?? null },
    callCount,
    totals: { promptTokens: totalPrompt, completionTokens: totalCompletion, avgLatencyMs: Math.round(avgLatency) },
    calls,
    bExport: (globalThis as Record<string, unknown>).__bExport ?? null,
  }
  return { md, json }
}

async function main(): Promise<void> {
  mkdirSync(reportsDir, { recursive: true })
  console.error(`路由 ${baseUrl}｜请求模型 ${model}｜预算 ${MAX_CALLS} 次`)
  await runArmA()
  await runArmB()
  const { md, json } = render()
  writeFileSync(join(reportsDir, 'REAL_MODEL_RUN.md'), md, 'utf8')
  writeFileSync(join(reportsDir, 'real-model-run.json'), JSON.stringify(json, null, 2), 'utf8')
  console.log(`\n完成：共 ${callCount} 次真实调用，已写入 reports/REAL_MODEL_RUN.md`)
}

await main()
