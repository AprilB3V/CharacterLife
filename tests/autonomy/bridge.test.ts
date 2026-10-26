/**
 * 世界 → 认知的受控桥（V0.4）。
 *
 * 断言重点：
 * - 只有已结算的动作写记忆；意图（pending/dispatched）不是经历；
 * - succeeded/failed/rejected 写 fact；从未派发的 expired 写 fact「没发生」；
 *   派发过但没回执的 expired 写 speculation；
 * - 世界记忆来源固定为 runtime_event、带 world 标签、可追溯到事件 id；
 * - 驱力只在 succeeded 时缓解；
 * - 例行快照只更新处境信念，带 event 的观察才写记忆；
 * - 同步幂等；src/world 依旧不引用 runtime / memory / workspace。
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOUR } from '../../src/kernel/util/clock.ts'
import { RUNTIME_ACTOR } from '../../src/kernel/policy/policy.ts'
import { WorldService } from '../../src/kernel/world/service.ts'
import { SANDBOX_ACTION_CATALOG } from '../../src/kernel/world/contracts.ts'
import { WorldBridge } from '../../src/kernel/cycle/bridge.ts'
import type { DriveProfile } from '../../src/kernel/semantics/drives.ts'
import { initDriveProposals } from '../../src/kernel/semantics/drives.ts'
import { SequentialIdFactory } from '../../src/kernel/util/ids.ts'
import { cleanupRigs, createRig } from '../helpers.ts'

const WORLD = 'w_test'
const INST = 'inst_test'
const DRIVES: DriveProfile = {
  specs: [{ name: 'hunger', label: '饥饿', risePerHour: 0.1, wakeThreshold: 0.7, initial: 0.6 }],
  satisfiers: [{ verb: 'eat', target: 'bread', effects: { hunger: -0.5 } }],
}

after(() => cleanupRigs())

function setup() {
  const rig = createRig()
  const ids = new SequentialIdFactory()
  const world = new WorldService({
    clock: rig.clock,
    ids,
    lookupInstance: (id) => (id === INST ? { worldId: WORLD } : null),
    worldIds: [WORLD],
    allowedVerbs: [...new Set(SANDBOX_ACTION_CATALOG.map((c) => c.verb))],
    allowedTargets: SANDBOX_ACTION_CATALOG.map((c) => c.target!).filter(Boolean),
    catalog: 'sandbox',
    acceptObservations: true,
    actionTtlSim: 10 * 60_000,
    leaseTtlSim: HOUR,
    maxAttempts: 1,
  })
  rig.workspace.motivation.setDriveProfile(DRIVES)
  rig.workspace.submitProposals(initDriveProposals(DRIVES, () => ids.next('pr')), RUNTIME_ACTOR)
  const bridge = new WorldBridge({ agent: rig.workspace, world, instanceId: INST, ids })
  const admit = (verb: string, target: string) => {
    const r = world.admit({
      worldId: WORLD,
      instanceId: INST,
      spec: { verb, target, args: {}, reason: 't', evidence: [], expectation: null, turnId: null },
    })
    assert.ok(r.ok)
    return r.action.actionId
  }
  const result = (actionId: string, result: 'succeeded' | 'failed' | 'rejected', eventId: string, summary = '') =>
    world.ingest(WORLD, [{ eventId, instanceId: INST, actionId, kind: 'action_result', result, atWorldTimeMs: 1, summary }])
  const observe = (eventId: string, facts: Array<{ key: string; value: string | number | boolean }>, summary = '') =>
    world.ingest(WORLD, [{ eventId, instanceId: INST, actionId: null, kind: 'observation', result: null, atWorldTimeMs: 1, summary, facts }])
  return { rig, world, bridge, admit, result, observe }
}

const worldMemories = (rig: ReturnType<typeof createRig>) => rig.workspace.memory.list({ tags: ['world'] })

describe('世界桥 · 动作结算', () => {
  it('意图不是经历：pending / dispatched 不写记忆', () => {
    const { rig, world, bridge, admit } = setup()
    admit('eat', 'bread')
    bridge.sync()
    world.lease(WORLD, 1)
    const sync = bridge.sync()
    assert.equal(sync.outcomes.length, 0)
    assert.equal(worldMemories(rig).length, 0)
    assert.equal(bridge.actionInFlight(), true)
  })

  it('succeeded → fact 记忆（runtime_event、world 标签、可追溯）+ 驱力缓解', () => {
    const { rig, world, bridge, admit, result } = setup()
    const id = admit('eat', 'bread')
    world.lease(WORLD, 1)
    result(id, 'succeeded', 'evt_ok', '吃完了')
    const sync = bridge.sync()
    assert.equal(sync.outcomes.length, 1)
    const mem = worldMemories(rig)
    assert.equal(mem.length, 1)
    assert.equal(mem[0]!.status, 'fact')
    assert.equal(mem[0]!.origin, 'runtime_event')
    assert.equal(mem[0]!.sourceRef, 'evt_ok')
    assert.ok(mem[0]!.tags.includes('world'))
    assert.equal(rig.workspace.dynamicState.drives?.hunger?.level, 0.1)
    assert.deepEqual(sync.outcomes[0]!.driveChanges, [{ path: 'drives.hunger', value: 0.1 }])
  })

  it('failed / rejected → fact 记忆，但驱力不变（说"吃过了"不算，世界确认才算）', () => {
    for (const status of ['failed', 'rejected'] as const) {
      const { rig, world, bridge, admit, result } = setup()
      const id = admit('eat', 'bread')
      world.lease(WORLD, 1)
      result(id, status, `evt_${status}`)
      bridge.sync()
      assert.equal(worldMemories(rig)[0]!.status, 'fact')
      assert.equal(rig.workspace.dynamicState.drives?.hunger?.level, 0.6, status)
    }
  })

  it('从未派发就过期 → fact「没发生」；派发过才过期 → speculation「不确定」', () => {
    const a = setup()
    a.admit('eat', 'bread')
    a.rig.clock.advance(11 * 60_000)
    a.world.expireStale()
    a.bridge.sync()
    assert.equal(worldMemories(a.rig)[0]!.status, 'fact')
    assert.match(worldMemories(a.rig)[0]!.content, /没有发生/)

    const b = setup()
    b.admit('eat', 'bread')
    b.world.lease(WORLD, 1)
    b.rig.clock.advance(2 * HOUR)
    b.world.expireStale()
    b.bridge.sync()
    assert.equal(worldMemories(b.rig)[0]!.status, 'speculation')
    assert.equal(b.rig.workspace.dynamicState.drives?.hunger?.level, 0.6)
  })

  it('同步幂等：重复调用不重复写记忆、不重复缓解驱力', () => {
    const { rig, world, bridge, admit, result } = setup()
    const id = admit('eat', 'bread')
    world.lease(WORLD, 1)
    result(id, 'succeeded', 'evt_ok')
    bridge.sync()
    bridge.sync()
    assert.equal(worldMemories(rig).length, 1)
    assert.equal(rig.workspace.dynamicState.drives?.hunger?.level, 0.1)
  })
})

describe('世界桥 · 观察', () => {
  it('快照只更新处境信念，不进长期记忆', () => {
    const { rig, bridge, observe } = setup()
    observe('obs_1', [
      { key: 'snapshot', value: true },
      { key: 'location', value: 'bakery' },
      { key: 'present', value: 'npc_lin' },
      { key: 'affords', value: 'buy(bread)' },
      { key: 'inventory.bread', value: 0 },
    ])
    const sync = bridge.sync()
    assert.equal(sync.salient.length, 0)
    assert.equal(worldMemories(rig).length, 0)
    assert.equal(sync.situation.location, 'bakery')
    assert.deepEqual(sync.situation.present, ['npc_lin'])
    assert.deepEqual(sync.situation.affords, ['buy(bread)'])
  })

  it('带 event 的观察是显著的：写 fact 记忆并作为唤醒原因', () => {
    const { rig, bridge, observe } = setup()
    observe('obs_2', [{ key: 'event', value: 'npc_arrived:npc_zhou' }], '周老师来了')
    const sync = bridge.sync()
    assert.equal(sync.salient.length, 1)
    assert.deepEqual(sync.salient[0]!.events, ['npc_arrived:npc_zhou'])
    const mem = worldMemories(rig)
    assert.equal(mem.length, 1)
    assert.equal(mem[0]!.sourceRef, 'obs_2')
    assert.equal(mem[0]!.content, '周老师来了')
  })

  it('处境是信念：下一次观察之前不会自己更新', () => {
    const { bridge, observe } = setup()
    observe('obs_a', [
      { key: 'snapshot', value: true },
      { key: 'location', value: 'bakery' },
      { key: 'affords', value: 'buy(bread)' },
    ])
    bridge.sync()
    // 世界那边面包可能已经卖完了，但没有新观察，信念保持不变
    assert.deepEqual(bridge.situation.affords, ['buy(bread)'])
  })
})

describe('世界桥 · 结构约束', () => {
  it('世界协议模块不 import 角色状态（memory / agent / cycle / runtime / persistence）', () => {
    const dir = join(process.cwd(), 'src', 'kernel', 'world')
    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), 'utf8')
      const imports = [...text.matchAll(/from '([^']+)'/g)].map((m) => m[1]!)
      for (const spec of imports) {
        assert.doesNotMatch(spec, /memory|agent|cycle|runtime|persistence|workspace|semantics/, `${file} 不应 import ${spec}`)
      }
    }
  })
})
