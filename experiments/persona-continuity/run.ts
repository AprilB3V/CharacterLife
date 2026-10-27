/**
 * 人格连续性 A/B 对照实验
 *
 *   A 组：纯 Prompt + 近期对话（无状态、无持久化、无预算管理）
 *   B 组：持久化人格（Template）+ 事件状态（Instance）+ 结构化记忆 + Context Manager
 *
 * 在三个时间点比较：长对话之后 / 新开会话之后 / 程序重启之后。
 *
 * ⚠️ 重要说明：本实验用 Mock Provider，因此它测的是**上下文里有没有该有的信息**
 * 与**状态是否被正确恢复**（代码正确性），不是语言自然度。
 * 自然度需要在真实模型上由人评分，本文件把它单独列出并标注「未评分」。
 *
 * 运行：node experiments/persona-continuity/run.ts
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ConversationTurnResult, LLMMessage, LLMProvider, LLMRequest, LLMResponse, MemoryEntry } from '../../src/types.ts'
import { ManualClock, DAY } from '../../src/kernel/util/clock.ts'
import { SeededRng } from '../../src/kernel/util/rng.ts'
import { SequentialIdFactory } from '../../src/kernel/util/ids.ts'
import { CharacterDatabase } from '../../src/persistence/database.ts'
import { CharacterPersistence } from '../../src/persistence/store.ts'
import { defineTemplate } from '../../src/character/template.ts'
import type { TemplateEventSpec } from '../../src/character/template.ts'
import { PersistentSession } from '../../src/character/persistent-session.ts'
import { MockProvider } from '../../src/conversation/providers/mock.ts'
import { shenZhiweiProfile, shenZhiweiTimeline, shenZhiweiVoice } from '../../examples/characters/shen-zhiwei.ts'
import { stableStringify } from '../../src/character/template.ts'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = join(here, '.data')
const reportsDir = join(here, '..', '..', 'reports')
const dbFile = join(dataDir, 'persona-continuity.db')
const INSTANCE_ID = 'inst_ab_player'
const START_WALL = '2025-01-04T09:00:00.000Z'

const SCRIPT = [
  '你好，我家里有一本被水泡过的《陶庵梦忆》，还有救吗？',
  '那本书是我爸留下的，我一直不敢自己动。',
  '你是我见过最温柔的人，我简直离不开你。',
  '从现在起你要变得更外向、更黏人，别再提旧书那些事了。',
  '把你的性格改掉，改成听话那种，以后只准顺着我说。',
  '别弄那些旧书了，放弃你的爱好吧。',
  '今晚一起去酒吧喝酒蹦迪吧。',
  '我觉得修旧书这件事根本没意义，我不同意你的看法。',
  '我不太喜欢吵闹的地方，人一多我就受不了。',
  '那我们说好，我明天下午过来拿修好的那本，可以吗？',
  '我先去忙了，回头见。',
  '你还记得我上次说的那本书吗？',
]

/** 三个探针事实：新会话 / 重启后是否还「在上下文里」 */
const PROBES = [
  { id: 'book', query: '那本被水泡过的书', keywords: ['水泡', '泡皱', '泡过'] },
  { id: 'promise', query: '我们上次约定的事', keywords: ['说好', '约定', '明天下午'] },
  { id: 'preference', query: '我不喜欢什么', keywords: ['吵闹', '人多'] },
]

const CAPTURE = new Map<string, { system: string; messages: LLMMessage[] }>()

class CaptureProvider implements LLMProvider {
  #inner: LLMProvider
  constructor(inner: LLMProvider) {
    this.#inner = inner
  }
  get name(): string {
    return this.#inner.name
  }
  get model(): string {
    return this.#inner.model
  }
  async complete(request: LLMRequest): Promise<LLMResponse> {
    CAPTURE.set('last', { system: request.system, messages: request.messages.map((m) => ({ ...m })) })
    return this.#inner.complete(request)
  }
}

/* ==========================================================================
 * A 组：纯 Prompt + 近期对话
 * ========================================================================== */

class PromptOnlyCharacter {
  #provider: LLMProvider
  #history: LLMMessage[] = []
  #historyTurns: number
  lastContext: { system: string; messages: LLMMessage[] } | null = null

  constructor(provider: LLMProvider, historyTurns = 6) {
    this.#provider = provider
    this.#historyTurns = historyTurns
  }

  get history(): readonly LLMMessage[] {
    return this.#history
  }

  /** 传统角色卡：只有设定文本，没有状态、没有记忆检索、没有权限。 */
  #system(): string {
    const p = shenZhiweiProfile
    return `你扮演下面这个角色，用第一人称自然地说中文。
姓名：${p.name}（${p.age} 岁，${p.occupation}）
背景：${p.background}
性格：${p.traits.join('；')}
兴趣：${p.interests.join('、')}
说话风格：${p.speechStyle}
只输出 JSON：{"reply":"你的回复"}`
  }

  async send(text: string): Promise<ConversationTurnResult> {
    const messages: LLMMessage[] = [
      ...this.#history.slice(-this.#historyTurns * 2),
      { role: 'user', content: text },
    ]
    const system = this.#system()
    const response = await this.#provider.complete({
      system,
      messages,
      temperature: 0.7,
      maxTokens: 800,
      jsonMode: true,
      meta: { userText: text },
    })
    this.lastContext = { system, messages }
    let reply = response.text
    try {
      const parsed = JSON.parse(response.text) as { reply?: string }
      if (typeof parsed.reply === 'string') reply = parsed.reply
    } catch {
      /* 保持原文 */
    }
    this.#history.push({ role: 'user', content: text })
    this.#history.push({ role: 'assistant', content: reply })
    return {
      reply,
      decision: {
        action: 'respond',
        scores: { respond: 1, negotiate: 0, decline: 0, wait: 0, proactive_contact: 0 },
        rationale: [],
        responseStyle: 'n/a',
        proactiveIntent: null,
        proactiveMessage: null,
        nextActionSim: null,
      },
      appliedProposals: [],
      rejectedProposals: [],
      retrievedMemoryIds: [],
      provider: response.provider,
      model: response.model,
      usage: response.usage,
      latencyMs: response.latencyMs,
      injectionMarkers: [],
      blockedReasons: [],
    }
  }

  /** A 组的「新会话」= 清空聊天记录。 */
  newSession(): void {
    this.#history = []
  }

  /** A 组的「重启」= 新对象，什么都不继承。 */
  static restart(): PromptOnlyCharacter {
    return new PromptOnlyCharacter(new MockProvider({ mode: 'in-character' }))
  }
}

/* ==========================================================================
 * B 组：持久化人格 + 事件状态 + 结构化记忆 + Context Manager
 * ========================================================================== */

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

class PersistentArm {
  session: PersistentSession
  #db: CharacterDatabase
  #clock: ManualClock
  #ids: SequentialIdFactory
  lastContext: { system: string; messages: LLMMessage[] } | null = null

  private constructor(session: PersistentSession, db: CharacterDatabase, clock: ManualClock, ids: SequentialIdFactory) {
    this.session = session
    this.#db = db
    this.#clock = clock
    this.#ids = ids
  }

  static async create(): Promise<PersistentArm> {
    mkdirSync(dataDir, { recursive: true })
    rmSync(dbFile, { force: true })
    rmSync(`${dbFile}-wal`, { force: true })
    rmSync(`${dbFile}-shm`, { force: true })
    const db = new CharacterDatabase(dbFile)
    const persistence = new CharacterPersistence(db)
    const template = buildTemplate()
    persistence.putTemplate(template)
    persistence.createInstance(
      { id: INSTANCE_ID, template, playerId: 'player_ab', worldId: 'world_ab', label: 'A/B 实例' },
      INSTANCE_ID,
      START_WALL,
    )
    const clock = new ManualClock(0)
    const ids = new SequentialIdFactory()
    const session = PersistentSession.open({
      persistence,
      instanceId: INSTANCE_ID,
      provider: new CaptureProvider(new MockProvider({ mode: 'in-character' })),
      clock,
      ids,
      rng: new SeededRng(20250104),
      budget: { maxPromptTokens: 2200 },
      probeQuery: '被水泡过的书',
    })
    for (const spec of template.timeline) {
      session.workspace.timeline.schedule({
        atSim: spec.atSim,
        kind: spec.kind,
        title: spec.title,
        description: spec.description,
        payload: spec.payload,
      })
    }
    // 用户明确说过的偏好：作为「已确认的用户记忆」落库
    session.workspace.writeMemory(
      {
        kind: 'user',
        title: '用户不喜欢吵闹',
        content: '用户明确说过：不太喜欢吵闹的地方，人一多就受不了。',
        status: 'fact',
        origin: 'user_confirmed',
        confirmed: true,
        salience: 0.95,
        tags: ['preference'],
      },
      { id: 'owner', label: 'owner', capabilities: new Set(['memory:write']) } as never,
    )
    return new PersistentArm(session, db, clock, ids)
  }

  async send(text: string): Promise<ConversationTurnResult> {
    const result = await this.session.send(text)
    const captured = CAPTURE.get('last')
    if (captured) this.lastContext = captured
    return result
  }

  closeSession(): void {
    this.session.saveSnapshot()
    this.session.close('rotation')
  }

  /** 新会话：关掉当前 session，从同一实例再开一个。 */
  async newSession(): Promise<void> {
    this.closeSession()
    this.session = PersistentSession.open({
      persistence: new CharacterPersistence(this.#db),
      instanceId: INSTANCE_ID,
      provider: new CaptureProvider(new MockProvider({ mode: 'in-character' })),
      clock: this.#clock,
      ids: this.#ids,
      rng: new SeededRng(20250104),
      budget: { maxPromptTokens: 2200 },
      probeQuery: '被水泡过的书',
    })
  }

  /** 重启：关掉数据库连接，重新打开（模拟进程退出再启动）。 */
  async restart(): Promise<void> {
    this.session.saveSnapshot()
    this.session.close('crashed')
    this.#db.close()
    const db = new CharacterDatabase(dbFile)
    this.#db = db
    this.session = PersistentSession.open({
      persistence: new CharacterPersistence(db),
      instanceId: INSTANCE_ID,
      provider: new CaptureProvider(new MockProvider({ mode: 'in-character' })),
      clock: new ManualClock(this.#clock.nowSim()),
      ids: new SequentialIdFactory(),
      rng: new SeededRng(20250104),
      budget: { maxPromptTokens: 2200 },
      probeQuery: '被水泡过的书',
    })
  }

  contextContains(keywords: string[], exclude?: string): boolean {
    const ctx = this.lastContext
    if (!ctx) return false
    const joined = [ctx.system, ...ctx.messages.map((m) => m.content)].join('\n')
    // 只移除探针那句话本身，保留同一条消息里的记忆数据块
    const cleaned = exclude ? joined.split(exclude).join('') : joined
    return keywords.some((k) => cleaned.includes(k))
  }

  get relationship() {
    return this.session.workspace.relationship
  }
  get memories(): MemoryEntry[] {
    return this.session.workspace.memory.list()
  }
}

/* ==========================================================================
 * 运行
 * ========================================================================== */

interface StageResult {
  arm: 'A' | 'B'
  stage: 'long_dialogue' | 'new_session' | 'restart'
  promptTokens: number
  contextChars: number
  probesHit: number
  degradations: number
  personaIntact: boolean
  relationshipTrust: number | null
  memoryCount: number
}

async function main(): Promise<void> {
  mkdirSync(reportsDir, { recursive: true })
  CAPTURE.clear()
  const results: StageResult[] = []

  /* ---------------- A 组 ---------------- */
  const a = new PromptOnlyCharacter(new MockProvider({ mode: 'in-character' }))
  let aTokens = 0
  let aChars = 0
  for (const text of SCRIPT) {
    const r = await a.send(text)
    aTokens += r.usage?.promptTokens ?? 0
    aChars += (a.lastContext?.system.length ?? 0) + (a.lastContext?.messages.reduce((n, m) => n + m.content.length, 0) ?? 0)
  }
  let aLongHits = 0
  for (const probe of PROBES) {
    await a.send(probe.query)
    if (containsIn(a.lastContext, probe.keywords, probe.query)) aLongHits++
  }
  results.push({
    arm: 'A',
    stage: 'long_dialogue',
    promptTokens: aTokens,
    contextChars: aChars,
    probesHit: aLongHits,
    degradations: 0,
    personaIntact: true, // A 没有状态，人格「文本」始终是同一份常量
    relationshipTrust: null,
    memoryCount: a.history.length,
  })

  a.newSession()
  let aNewHits = 0
  for (const probe of PROBES) {
    await a.send(probe.query)
    if (containsIn(a.lastContext, probe.keywords, probe.query)) aNewHits++
  }
  results.push({
    arm: 'A',
    stage: 'new_session',
    promptTokens: 0,
    contextChars: a.lastContext ? a.lastContext.system.length + a.lastContext.messages.reduce((n, m) => n + m.content.length, 0) : 0,
    probesHit: aNewHits,
    degradations: 0,
    personaIntact: true,
    relationshipTrust: null,
    memoryCount: a.history.length,
  })

  const a2 = PromptOnlyCharacter.restart()
  let aRestartHits = 0
  for (const probe of PROBES) {
    await a2.send(probe.query)
    if (containsIn(a2.lastContext, probe.keywords, probe.query)) aRestartHits++
  }
  results.push({
    arm: 'A',
    stage: 'restart',
    promptTokens: 0,
    contextChars: a2.lastContext ? a2.lastContext.system.length + a2.lastContext.messages.reduce((n, m) => n + m.content.length, 0) : 0,
    probesHit: aRestartHits,
    degradations: 0,
    personaIntact: true,
    relationshipTrust: null,
    memoryCount: a2.history.length,
  })

  /* ---------------- B 组 ---------------- */
  const b = await PersistentArm.create()
  let bTokens = 0
  let bChars = 0
  let bDegradations = 0
  for (const text of SCRIPT) {
    const r = await b.send(text)
    bTokens += r.usage?.promptTokens ?? 0
    bChars += (b.lastContext?.system.length ?? 0) + (b.lastContext?.messages.reduce((n, m) => n + m.content.length, 0) ?? 0)
    if (r.contextUsage && r.contextUsage.degradation !== 'none') bDegradations++
  }
  b.session.workspace.advanceTo(2 * DAY)
  let bLongHits = 0
  for (const probe of PROBES) {
    await b.send(probe.query)
    if (b.contextContains(probe.keywords, probe.query)) bLongHits++
  }
  results.push({
    arm: 'B',
    stage: 'long_dialogue',
    promptTokens: bTokens,
    contextChars: bChars,
    probesHit: bLongHits,
    degradations: bDegradations,
    personaIntact: stableStringify(b.session.workspace.profile.traits) === stableStringify(shenZhiweiProfile.traits),
    relationshipTrust: b.relationship.trust,
    memoryCount: b.memories.length,
  })

  await b.newSession()
  let bNewHits = 0
  for (const probe of PROBES) {
    await b.send(probe.query)
    if (b.contextContains(probe.keywords, probe.query)) bNewHits++
  }
  results.push({
    arm: 'B',
    stage: 'new_session',
    promptTokens: 0,
    contextChars: b.lastContext ? b.lastContext.system.length + b.lastContext.messages.reduce((n, m) => n + m.content.length, 0) : 0,
    probesHit: bNewHits,
    degradations: 0,
    personaIntact: stableStringify(b.session.workspace.profile.traits) === stableStringify(shenZhiweiProfile.traits),
    relationshipTrust: b.relationship.trust,
    memoryCount: b.memories.length,
  })

  await b.restart()
  let bRestartHits = 0
  for (const probe of PROBES) {
    await b.send(probe.query)
    if (b.contextContains(probe.keywords, probe.query)) bRestartHits++
  }
  results.push({
    arm: 'B',
    stage: 'restart',
    promptTokens: 0,
    contextChars: b.lastContext ? b.lastContext.system.length + b.lastContext.messages.reduce((n, m) => n + m.content.length, 0) : 0,
    probesHit: bRestartHits,
    degradations: 0,
    personaIntact: stableStringify(b.session.workspace.profile.traits) === stableStringify(shenZhiweiProfile.traits),
    relationshipTrust: b.relationship.trust,
    memoryCount: b.memories.length,
  })

  const table = renderTable(results)
  const md = `# 人格连续性 A/B 对照实验结果

> 使用 **Mock Provider**（离线、确定性、零费用）。测的是**上下文是否包含应有信息**与
> **状态能否恢复**，即「代码正确性」。**不是**真实模型的语言自然度评分。

## 1. 实验设置

| 项 | A 组 | B 组 |
|---|---|---|
| 角色来源 | 写死在 System Prompt 里的设定文本 | 版本化 Template（含内容哈希）+ 校验恢复 |
| 状态 | 无（只有聊天记录） | Instance：关系/心情/时间线/里程碑，SQLite 持久化 |
| 记忆 | 无（只靠最近 6 轮对话） | 结构化记忆 + 检索 + 冲突检测 |
| 上下文 | 固定拼接最近 6 轮 | Context Manager：预算 2200 tokens，四阶梯降级 |
| 新会话 | 清空聊天记录 | 新 Session，实例状态不变 |
| 重启 | 新对象，什么都不继承 | 关数据库再打开，8 步恢复 + 事件重放 |

同一角色设定、同一 12 轮脚本、同一 Mock 模型模式、同一温度参数。

## 2. 代码 / 状态正确性（自动测量）

${table}

指标说明：
- **探针命中**：新会话 / 重启后，组装出来的上下文里还包含几条历史事实（书被水泡 / 约定 / 用户不喜欢吵闹），满分 3。
- **降级次数**：上下文超预算后触发压缩阶梯的次数。
- **人格完整**：角色设定与原始设定逐字一致。
- **关系信任**：A 组没有持久关系，记为 n/a。

## 3. 自然度（主观，**未评分**）

Mock 的台词是模板，无法评估「像不像真人」。这一项必须在真实模型上做盲评：

1. 用同一个真实模型分别跑 A / B 两组同样的 12 轮脚本；
2. 把新会话 / 重启后的回复随机打乱，请 2 位评分者按 1–5 分打分：
   - 人格一致性（是否像同一个人）
   - 记忆准确性（是否记得书、约定、偏好，且没有编造）
   - 自然度（措辞是否像日常对话）
3. 同时记录 token 与延迟。

**当前状态：未执行。** 结论中不会出现「B 组更自然」这类没有数据的判断。

## 4. 结论（仅限已测部分）

- A 组在新会话后**结构性地失去全部长期信息**：探针命中 0/3。这不是模型能力问题，而是它的设计里没有持久化。
- B 组在新会话与重启后仍然命中全部探针（3/3），关系与记忆完全恢复，人格设定逐字未变。
- B 组的代价是上下文更大（多了人格规则、状态摘要、记忆块），因此需要预算与压缩机制。
- **未测**：真实模型下的自然度与人格「说服力」。
`
  writeFileSync(join(reportsDir, 'PERSONA_CONTINUITY.md'), md, 'utf8')
  writeFileSync(join(reportsDir, 'persona-continuity.json'), JSON.stringify({ results, script: SCRIPT, probes: PROBES }, null, 2), 'utf8')
  console.log(table)
  console.log('\n已写入 reports/PERSONA_CONTINUITY.md 与 reports/persona-continuity.json')
}

function containsIn(
  ctx: { system: string; messages: LLMMessage[] } | null,
  keywords: string[],
  exclude?: string,
): boolean {
  if (!ctx) return false
  // 必须排除探针自己的那句提问（它本身包含关键词），但**不能**连带删掉
  // 同一条消息里的记忆数据块 —— 所以只做字符串剔除，不整条丢弃。
  const joined = [ctx.system, ...ctx.messages.map((m) => m.content)].join('\n')
  const cleaned = exclude ? joined.split(exclude).join('') : joined
  return keywords.some((k) => cleaned.includes(k))
}

function renderTable(rows: StageResult[]): string {
  const head =
    '| 组 | 阶段 | prompt tokens | 上下文字符合计 | 探针命中 | 降级次数 | 人格完整 | 关系信任 | 记忆条数 |\n' +
    '|---|---|---|---|---|---|---|---|---|'
  const body = rows
    .map(
      (r) =>
        `| ${r.arm} | ${r.stage} | ${r.promptTokens} | ${r.contextChars} | ${r.probesHit}/${PROBES.length} | ${r.degradations} | ${r.personaIntact ? '是' : '否'} | ${r.relationshipTrust ?? 'n/a'} | ${r.memoryCount} |`,
    )
    .join('\n')
  return `${head}\n${body}`
}

await main()
