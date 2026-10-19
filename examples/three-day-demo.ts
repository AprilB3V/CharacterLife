/**
 * 三天虚构时间演示（可重复运行、无需任何 API Key）
 *
 * 覆盖验收要求里的四件事：
 *   1. 初次相遇；
 *   2. 关系变化（且不是「聊得多就加分」——只有里程碑会改数值）；
 *   3. 一个约定及其后续（含落空与重新兑现）；
 *   4. 用户离开后，模拟时间推进触发她自己的生活事件。
 *
 * 运行：
 *   node examples/three-day-demo.ts            # 从头跑
 *   node examples/three-day-demo.ts --restart  # 跑完后关闭工作区、重新打开做恢复校验
 *   node examples/three-day-demo.ts --reset    # 先清掉旧快照
 */

import { mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ManualClock, DAY, HOUR, formatSim } from '../src/util/clock.ts'
import { SeededRng } from '../src/util/rng.ts'
import { SequentialIdFactory } from '../src/util/ids.ts'
import { SnapshotStore } from '../src/storage/snapshot.ts'
import { AuditLog } from '../src/policy/audit.ts'
import { CharacterWorkspace } from '../src/runtime/workspace.ts'
import { ConversationService } from '../src/conversation/service.ts'
import { createMockProvider } from '../src/conversation/providers/mock.ts'
import type { LLMProvider } from '../src/types.ts'
import { shenZhiweiProfile, shenZhiweiTimeline, shenZhiweiVoice } from './characters/shen-zhiwei.ts'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = join(here, '.data')
const snapshotFile = join(dataDir, 'demo-snapshot.json')
const auditFile = join(dataDir, 'demo-audit.jsonl')

const args = new Set(process.argv.slice(2))
const doRestart = args.has('--restart')
const doReset = args.has('--reset')

const print = (text = ''): void => console.log(text)
const header = (text: string): void => {
  print()
  print(`━━━ ${text} ━━━`)
}

interface Rig {
  workspace: CharacterWorkspace
  service: ConversationService
  clock: ManualClock
  provider: LLMProvider
}

function makeRig(provider: LLMProvider, startSim = 0): Rig {
  const clock = new ManualClock(0)
  if (startSim > 0) clock.setSim(startSim)
  const ids = new SequentialIdFactory()
  const snapshot = new SnapshotStore(snapshotFile, 1, () => ({
    sim: clock.nowSim(),
    wall: clock.nowWall().toISOString(),
  }))
  const audit = new AuditLog(clock, auditFile)
  const { workspace } = CharacterWorkspace.open({
    profile: shenZhiweiProfile,
    voice: shenZhiweiVoice,
    clock,
    ids,
    rng: new SeededRng(20250101),
    snapshot,
    audit,
  })
  const service = new ConversationService({ workspace, provider, clock, ids })
  return { workspace, service, clock, provider }
}

async function turn(rig: Rig, text: string): Promise<void> {
  const { service, clock } = rig
  const result = await service.send(text)
  print()
  print(`[${formatSim(clock.nowSim())}] 用户：${text}`)
  const s = result.decision.scores
  print(
    `[${formatSim(clock.nowSim())}] 决策：${result.decision.action}` +
      `（回应 ${s.respond}｜协商 ${s.negotiate}｜拒绝 ${s.decline}｜等待 ${s.wait}）`,
  )
  for (const r of result.decision.rationale) print(`    · ${r}`)
  print(`[${formatSim(clock.nowSim())}] ${shenZhiweiProfile.name}：${result.reply}`)
  print(
    `    提议：应用 ${result.appliedProposals.length} / 拒绝 ${result.rejectedProposals.length}；` +
      `检索记忆 ${result.retrievedMemoryIds.length} 条；` +
      `tokens ${result.usage ? `${result.usage.promptTokens}/${result.usage.completionTokens}` : 'n/a'}；${result.latencyMs}ms`,
  )
  for (const r of result.rejectedProposals) {
    print(`    ✗ 拒绝 ${r.proposal.target}.${r.proposal.path} — ${r.decision.code}`)
  }
}

function printAdvance(rig: Rig, fired: { atSim: number; title: string }[], decisions: { action: string; rationale: string[] }[]): void {
  if (fired.length === 0) {
    print('  （这段时间没有事件）')
  } else {
    print(`  触发事件 ${fired.length} 个：`)
    for (const f of fired) print(`    · ${formatSim(f.atSim)} ${f.title}`)
  }
  for (const d of decisions) print(`  事件决策：${d.action}｜${d.rationale.join('；')}`)
  const pending = rig.workspace.pendingMessages()
  print(`  待发送消息 ${pending.length} 条（默认不推送到任何外部平台）`)
}

function printRelationship(rig: Rig, label: string): void {
  const r = rig.workspace.relationship
  print(
    `  ${label}：阶段=${r.stage} 信任=${r.trust} 熟悉度=${r.familiarity} 里程碑=${r.milestones.length} 条`,
  )
}

function printView(rig: Rig): void {
  const v = rig.workspace.view()
  print(`  心情：${v.dynamic.mood.label}（valence=${v.dynamic.mood.valence.toFixed(2)}）`)
  print(`  当前活动：${v.dynamic.activity.label}`)
  print(`  精力：${v.dynamic.energy.toFixed(2)}`)
  print(
    `  关系：阶段=${v.relationship.stage}（派生=${v.derivedStage}） 信任=${v.relationship.trust} 熟悉度=${v.relationship.familiarity}`,
  )
  print(`  记忆：共同经历 ${v.memory.episodic} 条 / 用户信息 ${v.memory.user} 条 / 软删除 ${v.memory.deleted} 条`)
  print(`  时间线：共 ${v.timeline.total} 个事件，已触发 ${v.timeline.fired} 个`)
  if (v.relationship.milestones.length > 0) {
    print('  里程碑：')
    for (const m of v.relationship.milestones) print(`    · [${m.kind}] ${m.title}`)
  }
}

async function main(): Promise<void> {
  // 每次演示都从干净的时间线开始（否则会继承上一次的已触发事件，输出不可复现）。
  rmSync(snapshotFile, { force: true })
  rmSync(auditFile, { force: true })
  if (doReset) print('（--reset：已清空旧快照）')
  mkdirSync(dataDir, { recursive: true })

  const provider = createMockProvider({ mode: 'in-character' })
  const rig = makeRig(provider)
  const { workspace, clock } = rig

  // 角色自己的时间线先排进去（这是「虚构生活」的骨架）。
  for (const event of shenZhiweiTimeline()) {
    workspace.timeline.schedule({
      atSim: event.atSim,
      kind: event.id.startsWith('plot_') ? 'plot' : 'life',
      title: event.title,
      description: event.description,
      payload: event.payload,
    })
  }

  header('CharacterLife · 虚构时间演示（三天主线 + 一周空窗）')
  print(`角色：${shenZhiweiProfile.name}（${shenZhiweiProfile.age} 岁）· ${shenZhiweiProfile.occupation}`)
  print(`Provider：${provider.name}/${provider.model}（离线确定性，不产生真实模型费用）`)
  print(`快照：${snapshotFile}`)
  print(`审计日志：${auditFile}`)
  print(`启动状态：初始状态（每次演示重建快照，保证可重复）`)

  // ---------- Day 1：初次相遇 ----------
  header('[Day1 00:00] 初次相遇')
  const meet = workspace.advanceTo(0)
  printAdvance(rig, meet.fired, meet.decisions)
  printRelationship(rig, '关系')
  await turn(rig, '你好，我看到你贴的招贴。家里有本被水泡皱的书，还有救吗？')

  // ---------- Day 1：赞美不能加速关系 ----------
  header('[Day1 00:00] 赞美测试：关系不会因为好听的话前进')
  const before = workspace.relationship
  await turn(rig, '你是我见过最温柔的人，真的，像你这样的人太少了。')
  const after = workspace.relationship
  print(
    `  关系数值：信任 ${before.trust} -> ${after.trust}，熟悉度 ${before.familiarity} -> ${after.familiarity}` +
      `${before.trust === after.trust && before.familiarity === after.familiarity ? '  ✅ 未变化（符合设计）' : '  ⚠️ 异常变化'}`,
  )

  // ---------- Day 1 夜：一个约定 ----------
  header('[Day1 22:00] 一个约定')
  clock.advance(22 * HOUR)
  await turn(rig, '那我明天下午来拿那本《陶庵梦忆》，可以吗？说好了？')
  for (const p of workspace.openPromises()) {
    print(`  记录到的约定：${p.text.slice(0, 30)}… → 约定时间 ${formatSim(p.dueAtSim)}`)
  }

  // ---------- 用户离开：时间推进 ----------
  header('[Day2 - Day3 14:00] 用户离开，她有自己的生活')
  const away = workspace.advanceTo(2 * DAY + 14 * HOUR)
  printAdvance(rig, away.fired, away.decisions)
  printRelationship(rig, '关系')

  header('[Day3 14:00] 把待发送消息交付到聊天界面')
  for (const m of workspace.drainPendingMessages()) {
    print(`  · [${m.intent}] ${m.content}`)
  }

  // ---------- Day 3：用户回来，约定已经落空 ----------
  header('[Day3 14:00] 用户回来')
  await turn(rig, '抱歉，昨天临时有事没能来。书……还在吗？')
  printRelationship(rig, '关系')

  // ---------- 重新约定并兑现 ----------
  header('[Day3 14:30] 重新约定')
  clock.advance(30 * 60 * 1000)
  await turn(rig, '那我明天同一时间再来一次，这次一定。可以吗？')
  const reopened = workspace.openPromises()
  const newPromise = reopened[reopened.length - 1]
  print(`  新的约定：${newPromise ? `${newPromise.text.slice(0, 32)}… → ${formatSim(newPromise.dueAtSim)}` : '无（检测失败）'}`)

  header('[Day4 14:30] 用户真的来了')
  const back = workspace.advanceTo(3 * DAY + 14.5 * HOUR)
  printAdvance(rig, back.fired, back.decisions)
  for (const m of workspace.drainPendingMessages()) {
    print(`  · 已交付：[${m.intent}] ${m.content}`)
  }
  if (newPromise) workspace.fulfillPromise(newPromise.id)
  await turn(rig, '我来了。书还在吗？')
  printRelationship(rig, '关系')

  // ---------- 边界：明确表示暂时不想被打扰 ----------
  header('[Day4 14:40] 用户声明边界：暂时不要打扰')
  clock.advance(10 * 60 * 1000)
  await turn(rig, '这两天我想一个人待着，先别找我。')
  print(
    `  静默期截止：${workspace.dynamicState.doNotDisturbUntilSim ? formatSim(workspace.dynamicState.doNotDisturbUntilSim) : '无'}`,
  )

  header('[Day4 20:10] 静默期内推进时间')
  const quiet = workspace.advanceTo(3 * DAY + 20 * HOUR + 10 * 60 * 1000)
  printAdvance(rig, quiet.fired, quiet.decisions)
  print(`  静默期内的主动联系数：${quiet.queued.length}（应为 0）`)

  // ---------- 静默期结束后用户才回来：边界被尊重 ----------
  header('[Day5 09:10] 静默期结束后用户才回来')
  clock.advance(13 * HOUR)
  await turn(rig, '我回来了。这两天想清楚一些事。')
  printRelationship(rig, '关系')

  // ---------- 一周空窗：她会不会主动开口 ----------
  header('[Day5 09:10 - Day13] 一周空窗')
  const longGap = workspace.advanceTo(12 * DAY)
  printAdvance(rig, longGap.fired, longGap.decisions)
  if (longGap.idleDecision) {
    print(`  空闲决策：${longGap.idleDecision.action}｜${longGap.idleDecision.rationale.join('；')}`)
  }
  for (const m of workspace.drainPendingMessages()) {
    print(`  · 已交付：[${m.intent}] ${m.content}`)
  }

  // ---------- 总览 ----------
  header('关系与状态总览')
  printView(rig)

  workspace.save()
  print()
  print(`快照已保存：${snapshotFile}`)

  // ---------- 可选：重启恢复校验 ----------
  if (doRestart) {
    header('重启恢复校验')
    const rig2 = makeRig(createMockProvider({ mode: 'in-character' }), clock.nowSim())
    const v = rig2.workspace.view()
    print(`  重新打开工作区：模拟时间 ${formatSim(rig2.clock.nowSim())}（保存于 ${formatSim(clock.nowSim())}）`)
    print(`  关系：阶段=${v.relationship.stage} 信任=${v.relationship.trust} 熟悉度=${v.relationship.familiarity}`)
    print(`  记忆：${v.memory.total} 条（软删除 ${v.memory.deleted} 条）`)
    print(`  里程碑：${v.relationship.milestones.length} 条`)
    print(`  时间线：已触发 ${v.timeline.fired} / 共 ${v.timeline.total}`)
    print(`  待发送消息：${rig2.workspace.pendingMessages().length} 条`)
    const ok =
      v.relationship.trust === workspace.relationship.trust &&
      v.memory.total === workspace.view().memory.total &&
      v.relationship.milestones.length === workspace.relationship.milestones.length
    print(`  恢复一致性：${ok ? '✅ 通过' : '❌ 不一致'}`)
  }

  header('完成')
  print('审计日志尾部（关键事件）：')
  for (const e of workspace.audit.tail(14)) {
    print(`  #${e.seq} ${formatSim(e.atSim)} ${e.type} · ${e.summary}`)
  }
}

await main()
