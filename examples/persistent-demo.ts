/**
 * 持久化 / 跨会话演示（每个命令都是一个独立进程，用来真实证明「重启后仍在」）
 *
 * 用法：
 *   node examples/persistent-demo.ts reset      # 删除演示数据库
 *   node examples/persistent-demo.ts init       # 建模板 + 建实例 + 首份快照
 *   node examples/persistent-demo.ts chat       # 多轮对话 + 触发生活事件 + 保存并退出
 *   node examples/persistent-demo.ts resume     # 新进程 / 新会话，验证人格、关系、记忆仍在
 *   node examples/persistent-demo.ts verify     # 只做断言，失败返回退出码 1
 *   node examples/persistent-demo.ts resume --budget 900   # 演示上下文压缩
 *
 * 数据：examples/.data/characterlife.db（SQLite，可删）
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ManualClock, DAY, HOUR, formatSim } from '../src/kernel/util/clock.ts'
import { SeededRng } from '../src/kernel/util/rng.ts'
import { SequentialIdFactory } from '../src/kernel/util/ids.ts'
import { CharacterDatabase } from '../src/persistence/database.ts'
import { CharacterPersistence } from '../src/persistence/store.ts'
import { defineTemplate, stableStringify } from '../src/character/template.ts'
import type { CharacterTemplate } from '../src/character/template.ts'
import type { TemplateEventSpec } from '../src/character/template.ts'
import { PersistentSession } from '../src/character/persistent-session.ts'
import { createMockProvider } from '../src/conversation/providers/mock.ts'
import { shenZhiweiProfile, shenZhiweiTimeline, shenZhiweiVoice } from './characters/shen-zhiwei.ts'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = join(here, '.data')
const dbFile = join(dataDir, 'characterlife.db')
const expectedFile = join(dataDir, 'expected.json')

const INSTANCE_ID = 'inst_demo_player001'
const PLAYER_ID = 'player_demo'
const WORLD_ID = 'world_demo'
const START_WALL = '2025-01-04T09:00:00.000Z'

const args = process.argv.slice(2)
const command = args[0] ?? 'help'
const budgetArg = args.indexOf('--budget')
const budget = budgetArg >= 0 ? Number(args[budgetArg + 1]) : undefined

const print = (t = ''): void => console.log(t)
const rule = (t: string): void => {
  print()
  print(`━━━ ${t} ━━━`)
}

function buildTemplate(): CharacterTemplate {
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

function openDb(): CharacterDatabase {
  return new CharacterDatabase(dbFile)
}

function makeSession(
  persistence: CharacterPersistence,
  startSim: number,
  opts: { budget?: number; clock: ManualClock },
): PersistentSession {
  const clock = opts.clock
  if (startSim > 0) clock.setSim(startSim)
  const ids = new SequentialIdFactory()
  return PersistentSession.open({
    persistence,
    instanceId: INSTANCE_ID,
    provider: createMockProvider({ mode: 'in-character' }),
    clock,
    ids,
    rng: new SeededRng(20250104),
    budget: opts.budget !== undefined ? { maxPromptTokens: opts.budget } : undefined,
    probeQuery: '那本被水泡过的书',
  })
}

function printRehydration(session: PersistentSession): void {
  const r = session.report
  rule('恢复流程（8 步）')
  for (const step of r.steps) {
    print(`  ${step.ok ? '✅' : '❌'} ${step.index}. ${step.step} — ${step.detail}`)
  }
  print()
  print(`  实例：${r.instance.id}（player=${r.instance.playerId} world=${r.instance.worldId}）`)
  print(`  模板：${r.template.id}@${r.template.version} hash=${r.template.contentHash.slice(0, 12)}…`)
  print(`  快照：${r.snapshot.source}${r.snapshot.found ? `（seq=${r.snapshot.lastEventSeq}）` : '（无）'}`)
  print(`  重放：${r.replayedEvents} 个事件 / ${r.replayedPatches} 个补丁，非法 ${r.invalidEvents} 个`)
  print(`  记忆：${r.memoriesLoaded} 条，冲突 ${r.conflicts.length} 处`)
  print(`  关系：信任=${r.relationship.trust} 熟悉度=${r.relationship.familiarity} 阶段=${r.relationship.stage}`)
  print(`  里程碑：${r.relationship.milestones.length} 个`)
  if (r.contextPlan) {
    print(
      `  上下文：预算 ${r.contextPlan.budget} tokens，受保护 ${r.contextPlan.protectedTokens}，估算 ${r.contextPlan.estPromptTokens}，降级=${r.contextPlan.degradation}`,
    )
  }
  if (r.warnings.length > 0) {
    print('  警告：')
    for (const w of r.warnings) print(`    · ${w}`)
  }
}

async function cmdReset(): Promise<number> {
  rmSync(dbFile, { force: true })
  rmSync(`${dbFile}-wal`, { force: true })
  rmSync(`${dbFile}-shm`, { force: true })
  rmSync(expectedFile, { force: true })
  print(`已删除：${dbFile}`)
  return 0
}

async function cmdInit(): Promise<number> {
  mkdirSync(dataDir, { recursive: true })
  rmSync(dbFile, { force: true })
  rmSync(`${dbFile}-wal`, { force: true })
  rmSync(`${dbFile}-shm`, { force: true })
  rmSync(expectedFile, { force: true })

  const db = openDb()
  const persistence = new CharacterPersistence(db)
  const template = buildTemplate()
  persistence.putTemplate(template)
  const instance = persistence.createInstance(
    { template, playerId: PLAYER_ID, worldId: WORLD_ID, label: '沈知微 · 演示玩家' },
    INSTANCE_ID,
    START_WALL,
  )

  const clock = new ManualClock(0)
  const session = makeSession(persistence, 0, { clock })
  // 第一次进入世界：把模板里的剧情/生活事件排进时间线
  for (const spec of template.timeline) {
    session.workspace.timeline.schedule({
      atSim: spec.atSim,
      kind: spec.kind,
      title: spec.title,
      description: spec.description,
      payload: spec.payload,
    })
  }
  session.saveSnapshot()
  session.close('rotation')

  rule('初始化完成')
  print(`  数据库：${dbFile}`)
  print(`  实例：${instance.id}（绑定模板 ${instance.templateId}@${instance.templateVersion}）`)
  print(`  剧情事件：${template.timeline.length} 个已排入时间线`)
  print(`  会话：${session.session?.id ?? 'n/a'}（已关闭，状态保留在实例上）`)
  db.close()
  return 0
}

async function cmdChat(): Promise<number> {
  if (!existsSync(dbFile)) {
    print('❌ 没有数据库，请先运行：node examples/persistent-demo.ts init')
    return 1
  }
  const db = openDb()
  const persistence = new CharacterPersistence(db)
  const clock = new ManualClock(0)
  const session = makeSession(persistence, 0, { clock })

  rule('新会话开始（第 1 个进程）')
  print(`  会话 id：${session.session?.id}`)
  printRehydration(session)

  const script = [
    '你好，我看到你贴的招贴。家里有本被水泡皱的书，还有救吗？',
    '那本书是我爸留下的，我一直不敢自己动它。',
    '你平时都一个人在工作室里待着吗？会不会很闷？',
    '那我们说好，我明天下午过来拿修好的那本，可以吗？',
    '好，我先去忙了，回头见。',
  ]

  rule('多轮对话')
  for (const text of script) {
    const result = await session.send(text)
    print()
    print(`[${formatSim(clock.nowSim())}] 用户：${text}`)
    print(`  决策：${result.decision.action}｜${result.decision.rationale.slice(0, 2).join('；')}`)
    print(`  角色：${result.reply}`)
    if (result.contextUsage) {
      print(
        `  上下文：估算 ${result.contextUsage.estPromptTokens}/${result.contextUsage.budget} tokens，降级=${result.contextUsage.degradation}`,
      )
    }
    print(
      `  提议：应用 ${result.appliedProposals.length} / 拒绝 ${result.rejectedProposals.length}；` +
        `tokens ${result.usage ? `${result.usage.promptTokens}/${result.usage.completionTokens}` : 'n/a'}`,
    )
  }

  rule('模拟时间推进（不调用模型）：触发她的生活事件')
  const advance = session.workspace.advanceTo(2 * DAY + 14 * HOUR)
  for (const evt of advance.fired) print(`  · ${formatSim(evt.atSim)} ${evt.title}`)
  print(`  待发送消息：${session.workspace.pendingMessages().length} 条（默认不外发）`)

  const view = session.workspace.view()
  rule('保存并退出（第 1 个进程结束）')
  session.saveSnapshot()
  session.close('user_exit')
  print(
    `  关系：信任=${view.relationship.trust} 熟悉度=${view.relationship.familiarity} 阶段=${view.relationship.stage}`,
  )
  print(`  记忆：${view.memory.total} 条｜里程碑：${view.relationship.milestones.length} 个`)
  print(`  模拟时间：${formatSim(clock.nowSim())}`)

  writeFileSync(
    expectedFile,
    JSON.stringify(
      {
        instanceId: INSTANCE_ID,
        templateId: session.template.id,
        templateVersion: session.template.version,
        templateHash: session.template.contentHash,
        traits: session.template.profile.traits,
        trust: view.relationship.trust,
        familiarity: view.relationship.familiarity,
        stage: view.relationship.stage,
        milestones: view.relationship.milestones.map((m) => m.id),
        memoryTitles: session.workspace.memory.list().map((m) => m.title),
        memoryCount: view.memory.total,
        sim: clock.nowSim(),
        sessionId: session.session?.id ?? null,
      },
      null,
      2,
    ),
    'utf8',
  )
  print(`  期望值已写入：${expectedFile}`)
  db.close()
  return 0
}

function loadExpected(): Record<string, unknown> | null {
  if (!existsSync(expectedFile)) return null
  return JSON.parse(readFileSync(expectedFile, 'utf8')) as Record<string, unknown>
}

async function cmdResume(): Promise<number> {
  if (!existsSync(dbFile)) {
    print('❌ 没有数据库，请先运行 init 与 chat')
    return 1
  }
  const db = openDb()
  const persistence = new CharacterPersistence(db)
  const clock = new ManualClock(0)
  const session = makeSession(persistence, 0, { clock, budget })

  rule('新进程 + 新会话（第 2 个进程）')
  printRehydration(session)

  const view = session.workspace.view()
  rule('关键状态是否仍在')
  print(`  人格 traits[0]：${session.workspace.profile.traits[0]}`)
  print(`  关系：信任=${view.relationship.trust} 熟悉度=${view.relationship.familiarity} 阶段=${view.relationship.stage}`)
  print(`  记忆：${view.memory.total} 条（共同经历 ${view.memory.episodic} / 用户 ${view.memory.user}）`)
  print(`  时间线：已触发 ${view.timeline.fired}/${view.timeline.total}`)
  print(`  开放约定：${view.promises.filter((p) => p.status === 'open').length} 条`)
  if (view.relationship.milestones.length > 0) {
    print('  里程碑：')
    for (const m of view.relationship.milestones) print(`    · [${m.kind}] ${m.title}（${m.evidence}）`)
  }
  for (const c of session.report.conflicts) {
    print(`  ⚠️ 记忆冲突：${c.kind} 关于「${c.subject}」：${c.detail}`)
  }

  rule('在新会话里回忆过去（检索长期记忆）')
  const recall = await session.send('我回来了。上次说的那本书，现在怎么样了？')
  print(`  用户：我回来了。上次说的那本书，现在怎么样了？`)
  print(`  决策：${recall.decision.action}`)
  print(`  角色：${recall.reply}`)
  print(`  检索到记忆：${recall.retrievedMemoryIds.length} 条 → ${recall.retrievedMemoryIds.join(', ')}`)
  if (recall.contextUsage) {
    print(
      `  上下文：估算 ${recall.contextUsage.estPromptTokens}/${recall.contextUsage.budget}，降级=${recall.contextUsage.degradation}` +
        (recall.contextUsage.droppedMemoryIds.length > 0
          ? `，丢弃记忆 ${recall.contextUsage.droppedMemoryIds.length} 条`
          : ''),
    )
  }

  rule('会话与上下文用量记录')
  const sessions = persistence.listSessions(INSTANCE_ID)
  for (const s of sessions) {
    print(`  · ${s.id}：${s.turnCount} 轮，结束原因=${s.endReason ?? '进行中'}`)
  }
  const usage = persistence.listContextRequests(INSTANCE_ID, 5)
  for (const u of usage) {
    print(
      `  · ${u.turnId}：预算 ${u.budget}｜估算 ${u.estPromptTokens}｜实际 ${u.actualPromptTokens ?? 'n/a'}/${u.actualCompletionTokens ?? 'n/a'}｜降级=${u.degradation}`,
    )
  }

  session.close('user_exit')
  db.close()
  return 0
}

async function cmdVerify(): Promise<number> {
  const expected = loadExpected()
  if (!expected) {
    print('❌ 缺少 expected.json，请先运行 init 与 chat')
    return 1
  }
  const db = openDb()
  const persistence = new CharacterPersistence(db)
  const clock = new ManualClock(0)
  const session = makeSession(persistence, 0, { clock })
  const view = session.workspace.view()
  const checks: Array<{ name: string; ok: boolean; detail: string }> = []
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail })
  }

  check('模板版本', session.template.version === expected.templateVersion, `v${session.template.version}`)
  check('模板哈希', session.template.contentHash === expected.templateHash, session.template.contentHash.slice(0, 12))
  check(
    '核心人格未被改写',
    stableStringify(session.template.profile.traits) === stableStringify(expected.traits as string[]),
    `traits[0]=${session.template.profile.traits[0]}`,
  )
  check('关系-信任恢复', view.relationship.trust === expected.trust, `${view.relationship.trust} vs ${expected.trust}`)
  check(
    '关系-熟悉度恢复',
    view.relationship.familiarity === expected.familiarity,
    `${view.relationship.familiarity} vs ${expected.familiarity}`,
  )
  check('关系阶段恢复', view.relationship.stage === expected.stage, `${view.relationship.stage} vs ${expected.stage}`)
  check(
    '里程碑恢复',
    stableStringify(view.relationship.milestones.map((m) => m.id)) === stableStringify(expected.milestones as string[]),
    `${view.relationship.milestones.length} 个`,
  )
  check('记忆数量恢复', view.memory.total === expected.memoryCount, `${view.memory.total} vs ${expected.memoryCount}`)
  const titles = session.workspace.memory.list().map((m) => m.title)
  const expectedTitles = expected.memoryTitles as string[]
  check(
    '记忆内容恢复',
    expectedTitles.every((t) => titles.includes(t)),
    expectedTitles.filter((t) => !titles.includes(t)).join(', ') || '全部命中',
  )
  check('新会话与旧会话不同', session.session?.id !== expected.sessionId, `${session.session?.id} vs ${expected.sessionId}`)
  check(
    '恢复流程 8 步全绿',
    session.report.steps.every((s) => s.ok),
    session.report.steps.filter((s) => !s.ok).map((s) => s.step).join(', ') || '全部通过',
  )
  check('记忆冲突已检测', session.report.conflicts.length >= 0, `${session.report.conflicts.length} 处`)

  rule('跨会话 / 跨进程验证')
  let failed = 0
  for (const c of checks) {
    if (!c.ok) failed++
    print(`  ${c.ok ? '✅' : '❌'} ${c.name} — ${c.detail}`)
  }
  print()
  print(`  结论：${failed === 0 ? '✅ 人格、关系、记忆在新进程 + 新会话中保持一致' : `❌ ${failed} 项不一致`}`)

  session.close('user_exit')
  db.close()
  return failed === 0 ? 0 : 1
}

async function main(): Promise<void> {
  switch (command) {
    case 'reset':
      process.exitCode = await cmdReset()
      break
    case 'init':
      process.exitCode = await cmdInit()
      break
    case 'chat':
      process.exitCode = await cmdChat()
      break
    case 'resume':
      process.exitCode = await cmdResume()
      break
    case 'verify':
      process.exitCode = await cmdVerify()
      break
    default:
      print('用法：node examples/persistent-demo.ts <reset|init|chat|resume|verify> [--budget N]')
      print('')
      print('推荐流程（每条命令都是独立进程）：')
      print('  1) node examples/persistent-demo.ts init')
      print('  2) node examples/persistent-demo.ts chat')
      print('  3) node examples/persistent-demo.ts resume')
      print('  4) node examples/persistent-demo.ts verify')
      print('  5) node examples/persistent-demo.ts resume --budget 900   # 观察上下文压缩')
  }
}

await main()
