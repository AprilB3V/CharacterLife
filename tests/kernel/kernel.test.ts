/**
 * 六语义微内核（V0.5）：结构边界、语义归属、语义槽、多角色宿主。
 *
 * 断言重点：
 * - src/kernel 不 import 内核之外的任何模块（陪伴、平台、持久化都在外面）；
 * - 每一条可写状态路径都恰好属于一个语义，审计记录带上语义；
 * - AgentCore 暴露六个语义槽，各自的纪律成立（观察默认不可信、处境是信念、承诺只结算一次……）；
 * - 陪伴角色（CharacterWorkspace）就是一个 AgentCore；对话消息进入 Observation 槽；
 * - AgentHost：世界先于角色推进；角色顺序确定（固定或轮转）。
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import {
  AffordanceRegistry,
  AgentCore,
  AgentHost,
  CONVERSATION_ACTOR,
  ManualClock,
  ObservationLog,
  RUNTIME_ACTOR,
  SEMANTICS,
  SequentialIdFactory,
  SeededRng,
  SituationStore,
  SnapshotStore,
  WRITABLE_PATHS,
  semanticOf,
} from '../../src/kernel/index.ts'
import type { AutonomyRunner } from '../../src/kernel/index.ts'
import { shenZhiweiProfile } from '../../examples/characters/shen-zhiwei.ts'
import { cleanupRigs, createRig } from '../helpers.ts'

after(() => cleanupRigs())

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })
}

function bareAgent(): AgentCore {
  const clock = new ManualClock(0)
  return new AgentCore({
    profile: shenZhiweiProfile,
    clock,
    ids: new SequentialIdFactory(),
    rng: new SeededRng(1),
    snapshot: new SnapshotStore('/nonexistent/never-saved.json', 1),
  })
}

describe('内核 · 结构边界', () => {
  it('src/kernel 只依赖自己和 node: 内置模块', () => {
    const kernel = resolve('src', 'kernel')
    for (const file of walk(kernel)) {
      const text = readFileSync(file, 'utf8')
      for (const m of text.matchAll(/^\s*(?:import|export)[^'"]*from\s+'([^']+)'/gm)) {
        const spec = m[1]!
        if (spec.startsWith('node:')) continue
        assert.ok(spec.startsWith('.'), `${relative(kernel, file)} 引用了外部包 ${spec}`)
        const target = resolve(join(file, '..'), spec)
        assert.ok(target.startsWith(kernel), `${relative(kernel, file)} 越界 import ${spec}`)
      }
    }
  })
})

describe('内核 · 语义归属', () => {
  it('六类语义齐全', () => {
    assert.deepEqual([...SEMANTICS], ['self', 'situation', 'observation', 'memory', 'motivation', 'affordance'])
  })

  it('每一条可写路径都恰好属于一个语义', () => {
    for (const path of WRITABLE_PATHS.dynamic) {
      assert.ok(semanticOf('dynamic', path), `dynamic.${path} 没有语义归属`)
    }
    for (const path of WRITABLE_PATHS.relationship) {
      assert.equal(semanticOf('relationship', path), 'memory', `relationship.${path}`)
    }
    assert.equal(semanticOf('dynamic', 'drives.hunger'), 'motivation')
    assert.equal(semanticOf('dynamic', 'mood.label'), 'self')
    assert.equal(semanticOf('dynamic', 'goals'), 'motivation')
    assert.equal(semanticOf('profile', 'traits'), 'self')
    assert.equal(semanticOf('timeline', 'event'), 'situation')
    assert.equal(semanticOf('policy', 'x'), 'governance')
    assert.equal(semanticOf('dynamic', 'not.a.path'), null)
  })

  it('审计记录带上所属语义（落地与拒绝都带）', () => {
    const agent = bareAgent()
    agent.submitProposals(
      [{ id: 'p1', target: 'dynamic', op: 'set', path: 'mood.label', value: '平静', reason: 't', evidence: [] }],
      RUNTIME_ACTOR,
    )
    agent.submitProposals(
      [{ id: 'p2', target: 'dynamic', op: 'set', path: 'drives.social', value: 0, reason: 't', evidence: [] }],
      CONVERSATION_ACTOR,
    )
    const events = agent.audit.tail(10)
    const applied = events.find((e) => e.type === 'proposal_applied')!
    const rejected = events.find((e) => e.type === 'proposal_rejected')!
    assert.equal(applied.data.semantic, 'self')
    assert.equal(rejected.data.semantic, 'motivation')
  })
})

describe('内核 · 六个语义槽', () => {
  it('AgentCore 暴露六个槽', () => {
    const agent = bareAgent()
    assert.equal(agent.self.persona.name, shenZhiweiProfile.name)
    assert.ok(agent.situation instanceof SituationStore)
    assert.ok(agent.observation instanceof ObservationLog)
    assert.equal(typeof agent.memory.search, 'function')
    assert.deepEqual(agent.motivation.drives(), [])
    assert.ok(agent.affordance instanceof AffordanceRegistry)
  })

  it('Self：人格只读；身心状况随提议变化', () => {
    const agent = bareAgent()
    assert.throws(() => {
      ;(agent.self.persona as { name: string }).name = 'x'
    })
    agent.submitProposals(
      [{ id: 'p', target: 'dynamic', op: 'set', path: 'energy', value: 0.2, reason: 't', evidence: [] }],
      RUNTIME_ACTOR,
    )
    assert.equal(agent.self.condition().energy, 0.2)
  })

  it('Observation：除 runtime 外默认不可信；游标读取；有上限', () => {
    const log = new ObservationLog({ max: 2 })
    const a = log.append({ atSim: 1, source: 'user', from: 'user', text: '你好', facts: [], events: [], ref: null })
    const b = log.append({ atSim: 2, source: 'runtime', from: null, text: 'tick', facts: [], events: [], ref: null })
    log.append({ atSim: 3, source: 'agent', from: 'npc', text: '嘿', facts: [], events: [], ref: null })
    assert.equal(a.trust, 'untrusted')
    assert.equal(b.trust, 'trusted')
    assert.deepEqual(log.since(a.seq).map((p) => p.atSim), [2, 3])
    assert.equal(log.size, 2)
  })

  it('Situation：是信念——只随观察更新，非快照不清空集合', () => {
    const s = new SituationStore()
    s.apply({ atSim: 1, facts: [{ key: 'snapshot', value: true }, { key: 'location', value: 'arena' }, { key: 'present', value: 'fox' }, { key: 'hp', value: 10 }] })
    s.apply({ atSim: 2, facts: [{ key: 'hp', value: 7 }] })
    const cur = s.current()
    assert.equal(cur.location, 'arena')
    assert.deepEqual(cur.present, ['fox'])
    assert.equal(cur.facts.hp, 7)
    assert.equal(cur.asOfSim, 2)
  })

  it('Motivation：承诺只能结算一次', () => {
    const agent = bareAgent()
    agent.motivation.add({ id: 'c1', text: '送面包', madeAtSim: 0, dueAtSim: 10, status: 'open', counterpart: 'npc_lin' })
    assert.equal(agent.motivation.due(5).length, 0)
    assert.equal(agent.motivation.due(10).length, 1)
    assert.equal(agent.motivation.settle('c1', 'kept'), true)
    assert.equal(agent.motivation.settle('c1', 'broken'), false)
    assert.equal(agent.motivation.get('c1')!.status, 'kept')
  })

  it('Affordance：按登记顺序汇总，可按渠道过滤', () => {
    const reg = new AffordanceRegistry()
    reg.register('world', () => [{ channel: 'x', verb: 'move_to', target: 'a', label: '', description: '', believedAvailable: true }])
    reg.register('conversation', () => [{ channel: 'x', verb: 'respond', target: null, label: '', description: '', believedAvailable: true }])
    assert.deepEqual(reg.list().map((o) => `${o.channel}:${o.verb}`), ['world:move_to', 'conversation:respond'])
    assert.equal(reg.list('world').length, 1)
  })
})

describe('陪伴扩展建在内核上', () => {
  it('CharacterWorkspace 是一个 AgentCore，并登记了对话渠道的可行动作', () => {
    const rig = createRig()
    assert.ok(rig.workspace instanceof AgentCore)
    assert.deepEqual(
      rig.workspace.affordance.list('conversation').map((o) => o.verb),
      ['respond', 'negotiate', 'decline', 'wait', 'proactive_contact'],
    )
  })

  it('用户消息进入 Observation 槽（不可信，可追溯到轮次）', async () => {
    const rig = createRig()
    await rig.service.send('你好，那本被水泡过的书还有救吗？')
    const [p] = rig.workspace.observation.latest(1)
    assert.equal(p!.source, 'user')
    assert.equal(p!.trust, 'untrusted')
    assert.match(p!.ref ?? '', /^turn_/)
  })

  it('约定落在内核的承诺账本里，旧快照字段名不变', async () => {
    const rig = createRig()
    await rig.service.send('那我们说好了，明天下午我来取书')
    assert.equal(rig.workspace.motivation.open().length, rig.workspace.openPromises().length)
    const runtime = rig.workspace.toJSON() as { promises: unknown[]; relationshipWrites: unknown[] }
    assert.ok(Array.isArray(runtime.promises))
    assert.ok(Array.isArray(runtime.relationshipWrites))
  })
})

describe('内核 · AgentHost', () => {
  function fakeRunner(name: string, log: string[]): AutonomyRunner {
    return { start: () => {}, step: async () => { log.push(name) } } as unknown as AutonomyRunner
  }

  it('每步世界先推进，再按固定顺序让角色行动', async () => {
    const log: string[] = []
    const clock = new ManualClock(0)
    const host = new AgentHost({ clock, tickMs: 1000 })
      .addWorld({ step: () => log.push('world') })
      .addAgent('a', fakeRunner('a', log))
      .addAgent('b', fakeRunner('b', log))
    await host.run(2000)
    assert.deepEqual(log, ['world', 'a', 'b', 'world', 'a', 'b'])
    assert.equal(clock.nowSim(), 2000)
  })

  it('rotate：每步起点后移一位（避免永远先手）', async () => {
    const log: string[] = []
    const host = new AgentHost({ clock: new ManualClock(0), tickMs: 1, order: 'rotate' })
      .addAgent('a', fakeRunner('a', log))
      .addAgent('b', fakeRunner('b', log))
      .addAgent('c', fakeRunner('c', log))
    await host.run(3)
    assert.deepEqual(log, ['a', 'b', 'c', 'b', 'c', 'a', 'c', 'a', 'b'])
  })

  it('同一个 id 不能登记两次', () => {
    const host = new AgentHost({ clock: new ManualClock(0) })
    host.addAgent('a', fakeRunner('a', []))
    assert.throws(() => host.addAgent('a', fakeRunner('a', [])))
  })
})
