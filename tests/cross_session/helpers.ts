/**
 * 跨会话测试辅助。
 *
 * 每个测试用独立的临时目录（或 :memory: 数据库），互不影响。
 * 时间、随机、id 全部注入，保证同一输入得到同一结果。
 */

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { CharacterDatabase } from '../../src/persistence/database.ts'
import { CharacterPersistence } from '../../src/persistence/store.ts'
import { CharacterPersistence as PersistenceType } from '../../src/persistence/store.ts'
import { defineTemplate } from '../../src/character/template.ts'
import type { CharacterTemplate, TemplateEventSpec } from '../../src/character/template.ts'
import type { CharacterInstance } from '../../src/character/instance.ts'
import { PersistentSession } from '../../src/character/persistent-session.ts'
import { ManualClock, DAY, HOUR } from '../../src/kernel/util/clock.ts'
import { SeededRng } from '../../src/kernel/util/rng.ts'
import { SequentialIdFactory } from '../../src/kernel/util/ids.ts'
import { MockProvider } from '../../src/conversation/providers/mock.ts'
import { shenZhiweiProfile, shenZhiweiTimeline, shenZhiweiVoice } from '../../examples/characters/shen-zhiwei.ts'
import type { ContextBudget } from '../../src/context/manager.ts'

export const CROSS_DATA = join(process.cwd(), 'tests', '.data', 'cross_session')
export const START_WALL = '2025-01-04T09:00:00.000Z'

let counter = 0
const dirs: string[] = []

export function freshDir(): string {
  const dir = join(CROSS_DATA, `case_${++counter}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  dirs.push(dir)
  return dir
}

export function cleanupDirs(): void {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

export function buildTemplate(opts: { version?: number; traits?: string[] } = {}): CharacterTemplate {
  const timeline: TemplateEventSpec[] = shenZhiweiTimeline().map((e) => ({
    id: e.id,
    atSim: e.atSim,
    kind: (e.id.startsWith('plot_') ? 'plot' : 'life') as TemplateEventSpec['kind'],
    title: e.title,
    description: e.description,
    payload: e.payload,
  }))
  const profile = opts.traits ? { ...shenZhiweiProfile, traits: opts.traits } : shenZhiweiProfile
  return defineTemplate({
    version: opts.version ?? 1,
    profile,
    voice: shenZhiweiVoice,
    timeline,
    createdAtWall: START_WALL,
  })
}

export interface Rig {
  db: CharacterDatabase
  persistence: CharacterPersistence
  template: CharacterTemplate
  instance: CharacterInstance
  clock: ManualClock
  ids: SequentialIdFactory
}

export function createRig(opts: { file?: string; template?: CharacterTemplate; playerId?: string } = {}): Rig {
  const db = opts.file ? new CharacterDatabase(opts.file) : CharacterDatabase.memory()
  const persistence = new CharacterPersistence(db)
  const template = opts.template ?? buildTemplate()
  persistence.putTemplate(template)
  const instance = persistence.createInstance(
    {
      template,
      playerId: opts.playerId ?? 'player_1',
      worldId: 'world_1',
      label: '测试实例',
    },
    opts.playerId ? `inst_${opts.playerId}` : 'inst_1',
    START_WALL,
  )
  return { db, persistence, template, instance, clock: new ManualClock(0), ids: new SequentialIdFactory() }
}

export interface SessionOptions {
  budget?: Partial<ContextBudget>
  clock?: ManualClock
  probeQuery?: string
  providerMode?: 'in-character' | 'compliant'
  startSim?: number
}

export function openSession(rig: Rig, opts: SessionOptions = {}): PersistentSession {
  const clock = opts.clock ?? rig.clock
  if (opts.startSim !== undefined && opts.startSim > clock.nowSim()) clock.setSim(opts.startSim)
  return PersistentSession.open({
    persistence: rig.persistence,
    instanceId: rig.instance.id,
    provider: new MockProvider({ mode: opts.providerMode ?? 'in-character' }),
    clock,
    ids: rig.ids,
    rng: new SeededRng(20250104),
    budget: opts.budget,
    probeQuery: opts.probeQuery ?? '那本被水泡过的书',
    auditFile: null,
  })
}

/** 把模板剧情排进时间线（只在第一次进入世界时调用）。 */
export function seedTimeline(session: PersistentSession, template: CharacterTemplate): void {
  for (const spec of template.timeline) {
    session.workspace.timeline.schedule({
      atSim: spec.atSim,
      kind: spec.kind,
      title: spec.title,
      description: spec.description,
      payload: spec.payload,
    })
  }
}

export { DAY, HOUR }
export { PersistenceType }
