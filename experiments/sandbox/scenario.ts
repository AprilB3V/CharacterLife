/**
 * 文字箱庭场景装配：沈知微在小镇里的一天。
 *
 * 箱庭角色直接跑在**六语义内核**（AgentCore）上，不经过任何陪伴/聊天代码：
 * AgentCore + WorldService（sandbox 目录 + 观察）+ TextWorld（无画面 CL-World）
 * + 桥接层 + Waker + Mind。Free Roam 的斗场角色用的是同一套组合。
 * run.ts、h5.ts 和测试都从这里取同一套装配，保证"实验跑的"就是"测试测的"。
 */

import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentCore } from '../../src/kernel/agent.ts'
import { AgentHost } from '../../src/kernel/host.ts'
import { SnapshotStore } from '../../src/kernel/storage/snapshot.ts'
import { AuditLog } from '../../src/kernel/policy/audit.ts'
import { WorldService } from '../../src/kernel/world/service.ts'
import { SANDBOX_ACTION_CATALOG } from '../../src/kernel/world/contracts.ts'
import { HOUR, ManualClock } from '../../src/kernel/util/clock.ts'
import { SequentialIdFactory } from '../../src/kernel/util/ids.ts'
import { SeededRng } from '../../src/kernel/util/rng.ts'
import type { Rng } from '../../src/kernel/util/rng.ts'
import { Integrity } from '../../src/kernel/integrity/index.ts'
import type { AuthorityToken } from '../../src/kernel/integrity/index.ts'
import { OWNER_ACTOR } from '../../src/kernel/policy/policy.ts'
import { WorldBridge } from '../../src/kernel/cycle/bridge.ts'
import type { DriveProfile } from '../../src/kernel/semantics/drives.ts'
import type { Mind, RuleMindConfig } from '../../src/kernel/cycle/mind.ts'
import { RuleMind } from '../../src/kernel/cycle/mind.ts'
import type { AutonomyLogRecord } from '../../src/kernel/cycle/runner.ts'
import { AutonomyRunner } from '../../src/kernel/cycle/runner.ts'
import type { WakerConfig } from '../../src/kernel/cycle/waker.ts'
import { shenZhiweiProfile } from '../../examples/characters/shen-zhiwei.ts'
import { TextWorld } from './world.ts'

export const SANDBOX_WORLD_ID = 'cl-sandbox-town'
export const SANDBOX_INSTANCE_ID = 'inst_sandbox_shen'

/**
 * 沈知微的内驱力。数值是**可调的实验参数**，不是对真人的建模：
 *   - 内向，所以社交需求上升慢、阈值高；
 *   - 好奇心是她修书、逛旧货摊的动力；
 *   - 早饭吃过了，饥饿从 0.3 起。
 */
export const SHEN_DRIVES: DriveProfile = {
  specs: [
    { name: 'hunger', label: '饥饿', risePerHour: 0.11, wakeThreshold: 0.7, initial: 0.3 },
    { name: 'social', label: '想和人说说话', risePerHour: 0.06, wakeThreshold: 0.65, initial: 0.2 },
    { name: 'curiosity', label: '好奇心', risePerHour: 0.12, wakeThreshold: 0.6, initial: 0.2 },
  ],
  satisfiers: [
    { verb: 'eat', target: 'bread', effects: { hunger: -0.7 } },
    { verb: 'talk_to', target: 'npc_lin', effects: { social: -0.5 } },
    { verb: 'talk_to', target: 'npc_zhou', effects: { social: -0.6, curiosity: -0.1 } },
    { verb: 'browse', target: 'stall', effects: { curiosity: -0.6 } },
    { verb: 'repair', target: 'old_book', effects: { curiosity: -0.15 } },
  ],
}

export const SHEN_RULE_MIND: RuleMindConfig = {
  remedies: {
    hunger: ['eat(bread)'],
    social: ['talk_to(npc_zhou)', 'talk_to(npc_lin)'],
    curiosity: ['browse(stall)', 'repair(old_book)'],
  },
  means: { 'eat(bread)': ['buy(bread)'] },
  routine: ['repair(old_book)', 'rest(bed)'],
  places: ['workshop', 'bakery', 'plaza'],
  actFloor: 0.5,
}

/** 世界 id → 显示名（给 Mind 与日志渲染用） */
export const SANDBOX_NAMES: Readonly<Record<string, string>> = {
  workshop: '工作室',
  bakery: '面包房',
  plaza: '广场',
  npc_lin: '林姐',
  npc_zhou: '周老师',
  bread: '面包',
}

export type Condition = 'A' | 'B'

/** H5 两组：A = 只有心跳和事件唤醒、Mind 看不到驱力；B = 驱力参与唤醒并交给 Mind。 */
export function wakerFor(condition: Condition): WakerConfig {
  return {
    useDrives: condition === 'B',
    heartbeatMs: 90 * 60_000,
    minGapMs: 15 * 60_000,
    driveRepeatMs: 60 * 60_000,
    maxWakesPerHour: 6,
  }
}

export interface SandboxOptions {
  seed: number
  condition: Condition
  /** 默认 RuleMind；传入 LlmMind 即为真实模型 */
  mind?: Mind
  /** 起始时刻（模拟毫秒），默认 Day1 08:00 */
  startSim?: number
  logger?: (record: AutonomyLogRecord) => void
  /** 审计日志文件；null = 只在内存 */
  auditFile?: string | null
  breadStock?: number
  /** 是否启用完整性层（宪法 K1–K6），默认启用 */
  integrity?: boolean
}

export interface Sandbox {
  clock: ManualClock
  /** 角色内核（六个语义槽都在上面） */
  agent: AgentCore
  world: WorldService
  town: TextWorld
  bridge: WorldBridge
  runner: AutonomyRunner
  mind: Mind
}

export function createSandbox(opts: SandboxOptions): Sandbox {
  const clock = new ManualClock(0)
  clock.setSim(opts.startSim ?? 8 * HOUR)
  const ids = new SequentialIdFactory()
  const audit = new AuditLog(clock, opts.auditFile ?? null)
  // 快照只在显式 save() 时写盘；箱庭运行不保存，路径只是占位
  const snapshot = new SnapshotStore(join(tmpdir(), `cl-sandbox-${opts.seed}-${opts.condition}.json`), 1, () => ({
    sim: clock.nowSim(),
    wall: clock.nowWall().toISOString(),
  }))
  // 完整性层：账本主体是这个角色；世界的随机性来自登记过的种子流（K4）
  const integrity =
    opts.integrity === false
      ? null
      : new Integrity({ clock, subject: { id: shenZhiweiProfile.id, persona: shenZhiweiProfile } })
  let worldRng: Rng = new SeededRng(opts.seed * 7919 + 13)
  let authority: AuthorityToken | null = null
  if (integrity) {
    const stream = integrity.registerSeedStream('sandbox', 'world', `sandbox-${opts.seed}`)
    if (stream.ok) worldRng = stream.rng
    const reg = integrity.registerAuthority(OWNER_ACTOR, `cl-world:${SANDBOX_WORLD_ID}`, ['world.action', 'world.observation'])
    if (reg.ok) authority = reg.token
  }

  const agent = new AgentCore({
    profile: shenZhiweiProfile,
    clock,
    ids,
    rng: new SeededRng(opts.seed),
    snapshot,
    audit,
    drives: SHEN_DRIVES,
    integrity,
  })

  const verbs = [...new Set(SANDBOX_ACTION_CATALOG.map((c) => c.verb))]
  const targets = [...new Set(SANDBOX_ACTION_CATALOG.map((c) => c.target).filter((t): t is string => t !== null))]
  const world = new WorldService({
    clock,
    ids,
    lookupInstance: (id) => (id === SANDBOX_INSTANCE_ID ? { worldId: SANDBOX_WORLD_ID } : null),
    worldIds: [SANDBOX_WORLD_ID],
    allowedVerbs: verbs,
    allowedTargets: targets,
    catalog: 'sandbox',
    acceptObservations: true,
    // 箱庭里动作要执行几十分钟：租约必须覆盖最长动作，过期窗口覆盖一个调度步
    actionTtlSim: 30 * 60_000,
    leaseTtlSim: 3 * HOUR,
    maxAttempts: 1,
  })

  const town = new TextWorld({
    world,
    worldId: SANDBOX_WORLD_ID,
    instanceId: SANDBOX_INSTANCE_ID,
    clock,
    // 世界的随机源与角色的随机源分开：换 Mind 不会改变世界的安排
    rng: worldRng,
    breadStock: opts.breadStock,
  })

  const labels = new Map(SANDBOX_ACTION_CATALOG.map((c) => [`${c.verb}(${c.target ?? '*'})`, c.label]))
  const bridge = new WorldBridge({
    agent,
    world,
    instanceId: SANDBOX_INSTANCE_ID,
    ids,
    authority,
    labelFor: (verb, target) => labels.get(`${verb}(${target ?? '*'})`) ?? `${verb}(${target ?? '*'})`,
  })

  const mind = opts.mind ?? new RuleMind(SHEN_RULE_MIND)
  const runner = new AutonomyRunner({
    agent,
    world,
    worldId: SANDBOX_WORLD_ID,
    instanceId: SANDBOX_INSTANCE_ID,
    bridge,
    mind,
    waker: wakerFor(opts.condition),
    driveInputToMind: opts.condition === 'B',
    names: SANDBOX_NAMES,
    ids,
    logger: opts.logger,
  })

  return { clock, agent, world, town, bridge, runner, mind }
}

export interface RunOptions {
  /** 模拟多少小时 */
  hours: number
  /** 调度步长（模拟毫秒），默认 5 分钟 */
  tickMs?: number
  /** 干预：在某个时刻把某条驱力设为某值 */
  intervention?: { atSim: number; drive: string; value: number } | null
}

/**
 * 跑一段时间：交给内核的 AgentHost 调度（世界先推进，再让角色同步与决策）。
 * 同一种子 + 同一 Mind 输出 → 同一份日志。
 */
export async function runSandbox(sb: Sandbox, opts: RunOptions): Promise<void> {
  const host = new AgentHost({ clock: sb.clock, tickMs: opts.tickMs ?? 5 * 60_000 })
    .addWorld(sb.town)
    .addAgent(SANDBOX_INSTANCE_ID, sb.runner)
  let intervened = false
  await host.run(opts.hours * HOUR, {
    beforeAgents: (now) => {
      if (opts.intervention && !intervened && now >= opts.intervention.atSim) {
        sb.runner.intervene(opts.intervention.drive, opts.intervention.value)
        intervened = true
      }
    },
  })
}
