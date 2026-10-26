/**
 * V0.4 对世界协议的增量：命名目录与观察事件。
 *
 * 断言重点：
 * - 不显式选择时，目录与观察行为与第一阶段逐字一致；
 * - sandbox 目录同样是代码常量，manifest 仍按服务端白名单过滤；
 * - 箱庭动词不接受参数（含义完全由 verb + target 决定）；
 * - 观察事件需要显式开启；开启后同样做 eventId 去重与实例/世界归属校验。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ManualClock } from '../../src/util/clock.ts'
import { SequentialIdFactory } from '../../src/util/ids.ts'
import { WorldService } from '../../src/world/service.ts'
import type { WorldServiceOptions } from '../../src/world/service.ts'
import { SANDBOX_ACTION_CATALOG, WORLD_ACTION_CATALOG, checkActionArgs } from '../../src/world/contracts.ts'

const WORLD = 'w'
const INST = 'i1'

function make(over: Partial<Omit<WorldServiceOptions, 'clock' | 'ids' | 'lookupInstance'>> = {}) {
  return new WorldService({
    clock: new ManualClock(0),
    ids: new SequentialIdFactory(),
    lookupInstance: (id) => (id === INST ? { worldId: WORLD } : id === 'i_other' ? { worldId: 'other' } : null),
    worldIds: [WORLD],
    allowedVerbs: ['use', 'move_to', 'eat'],
    allowedTargets: ['desk_01', 'bakery', 'bread'],
    ...over,
  })
}

const obs = (eventId: string, instanceId = INST) => ({
  eventId,
  instanceId,
  actionId: null,
  kind: 'observation',
  result: null,
  atWorldTimeMs: 5,
  summary: '有人来了',
  facts: [{ key: 'event', value: 'npc_arrived:npc_lin' }],
})

describe('命名动作目录', () => {
  it('默认目录不变：只有 use(desk_01)', () => {
    const svc = make()
    assert.equal(svc.catalog, 'default')
    assert.deepEqual(svc.manifest().map((c) => `${c.verb}(${c.target})`), ['use(desk_01)'])
    assert.equal(WORLD_ACTION_CATALOG.length, 1)
  })

  it('sandbox 目录按白名单过滤', () => {
    const svc = make({ catalog: 'sandbox' })
    assert.deepEqual(svc.manifest().map((c) => `${c.verb}(${c.target})`), ['move_to(bakery)', 'eat(bread)'])
  })

  it('箱庭动词不接受参数；use 的规则保持原样', () => {
    for (const c of SANDBOX_ACTION_CATALOG) {
      assert.equal(checkActionArgs(c.verb, {}).ok, true, c.verb)
      if (c.verb !== 'use') assert.equal(checkActionArgs(c.verb, { seconds: 1 }).ok, false, c.verb)
    }
    assert.equal(checkActionArgs('use', { seconds: 3 }).ok, true)
    assert.equal(checkActionArgs('destroy', {}).ok, false)
  })

  it('目录外的动作仍被 admit() 拒绝', () => {
    const svc = make({ catalog: 'sandbox', allowedVerbs: ['move_to'], allowedTargets: ['bakery'] })
    const r = svc.admit({
      worldId: WORLD,
      instanceId: INST,
      spec: { verb: 'eat', target: 'bread', args: {}, reason: '', evidence: [], expectation: null, turnId: null },
    })
    assert.equal(r.ok, false)
  })
})

describe('观察事件', () => {
  it('默认关闭：仍按 UNSUPPORTED_KIND 拒绝', () => {
    const r = make().ingest(WORLD, [obs('o1')])
    assert.equal(r.rejected[0]!.code, 'UNSUPPORTED_KIND')
    assert.equal(make().observations(INST).length, 0)
  })

  it('开启后：接受、暂存、eventId 去重、游标读取', () => {
    const svc = make({ acceptObservations: true })
    const r1 = svc.ingest(WORLD, [obs('o1'), obs('o2')])
    assert.deepEqual(r1.accepted, ['o1', 'o2'])
    assert.equal(r1.applied.observationsRecorded, 2)
    assert.deepEqual(svc.ingest(WORLD, [obs('o1')]).duplicates, ['o1'])
    const all = svc.observations(INST)
    assert.equal(all.length, 2)
    assert.equal(svc.observations(INST, all[0]!.seq).length, 1)
    // 只读拷贝：改返回值不影响服务内记录
    all[0]!.facts.length = 0
    assert.equal(svc.observations(INST)[0]!.facts.length, 1)
  })

  it('开启后：未知实例、跨世界实例都被拒绝', () => {
    const svc = make({ acceptObservations: true })
    assert.equal(svc.ingest(WORLD, [obs('o1', 'nobody')]).rejected[0]!.code, 'UNKNOWN_INSTANCE')
    assert.equal(svc.ingest(WORLD, [obs('o2', 'i_other')]).rejected[0]!.code, 'INSTANCE_WORLD_MISMATCH')
  })

  it('观察暂存有上限，超出丢最旧的', () => {
    const svc = make({ acceptObservations: true, maxObservations: 3 })
    svc.ingest(WORLD, ['a', 'b', 'c', 'd', 'e'].map((id) => obs(id)))
    assert.deepEqual(svc.observations(INST).map((o) => o.eventId), ['c', 'd', 'e'])
  })
})
