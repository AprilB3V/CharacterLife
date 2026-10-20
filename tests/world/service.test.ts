/**
 * WorldService 单元测试（第一阶段：内存队列）。
 *
 * 断言重点：
 * - worldId / instanceId 由服务端解析并绑定，调用方改不动；
 * - 三态结果只有 succeeded / failed / rejected；
 * - eventId 与 actionId 双层去重；
 * - 过期语义：从未领取 → failed（确定没发生）；领取过但无回执 → uncertain（可能已发生）；
 * - 回执不产生记忆、状态或提议（`applied` 只有 actionsUpdated）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ManualClock } from '../../src/util/clock.ts'
import { SequentialIdFactory } from '../../src/util/ids.ts'
import { WorldService } from '../../src/world/service.ts'
import type { WorldServiceOptions } from '../../src/world/service.ts'
import { narrationFor } from '../../src/world/state.ts'
import type { WorldEvent } from '../../src/world/contracts.ts'

const WORLD = 'cl-world-test'
const INSTANCE = 'inst_001'

type ServiceOverrides = Partial<Omit<WorldServiceOptions, 'clock' | 'ids' | 'lookupInstance'>>

function makeService(overrides: ServiceOverrides = {}) {
  const clock = new ManualClock(0)
  const ids = new SequentialIdFactory()
  const instances = new Map<string, { worldId: string }>([
    [INSTANCE, { worldId: WORLD }],
    ['inst_other_world', { worldId: 'another-world' }],
  ])
  const service = new WorldService({
    clock,
    ids,
    lookupInstance: (id) => instances.get(id) ?? null,
    worldIds: [WORLD],
    allowedVerbs: ['use'],
    allowedTargets: ['desk_01'],
    ...overrides,
  })
  return { service, clock, ids, instances }
}

function spec(overrides: { verb?: string; target?: string | null; args?: Record<string, unknown> } = {}) {
  return {
    verb: overrides.verb ?? 'use',
    target: overrides.target === undefined ? 'desk_01' : overrides.target,
    args: overrides.args ?? { seconds: 2 },
    reason: '测试动作',
    evidence: [],
    expectation: '角色使用书桌',
    turnId: null,
  }
}

function admitOk(service: WorldService, overrides: { verb?: string; target?: string | null } = {}) {
  const result = service.admit({ worldId: WORLD, instanceId: INSTANCE, spec: spec(overrides) })
  if (!result.ok) throw new Error(`准入失败：${result.code} ${result.reasons.join('；')}`)
  return result.action
}

function resultEvent(
  overrides: Partial<Omit<WorldEvent, 'eventId' | 'actionId'>> & { eventId: string; actionId: string },
): WorldEvent {
  return {
    worldId: WORLD,
    instanceId: INSTANCE,
    kind: 'action_result',
    result: 'succeeded',
    atWorldTimeMs: 1000,
    summary: '执行完成',
    facts: [],
    code: null,
    ...overrides,
  }
}

describe('World · 准入与身份绑定', () => {
  it('固定动作 use(desk_01) 可准入，身份由服务端绑定，初始为 pending/intent', () => {
    const { service } = makeService()
    const action = admitOk(service)
    assert.equal(action.actionId, 'wa_001')
    assert.equal(action.worldId, WORLD)
    assert.equal(action.instanceId, INSTANCE)
    assert.equal(action.verb, 'use')
    assert.equal(action.target, 'desk_01')
    assert.equal(action.status, 'pending')
    assert.equal(action.narration, 'intent')
    assert.equal(action.attempts, 0)
    assert.ok(action.correlationId.startsWith(`${INSTANCE}:`))
  })

  it('未授权世界、实例不存在、实例跨世界均被拒绝', () => {
    const { service } = makeService()
    assert.equal(
      service.admit({ worldId: 'unknown-world', instanceId: INSTANCE, spec: spec() }).ok,
      false,
    )
    const noInstance = service.admit({ worldId: WORLD, instanceId: 'inst_missing', spec: spec() })
    assert.equal(noInstance.ok, false)
    if (!noInstance.ok) assert.equal(noInstance.code, 'INSTANCE_NOT_FOUND')

    const crossWorld = service.admit({ worldId: WORLD, instanceId: 'inst_other_world', spec: spec() })
    assert.equal(crossWorld.ok, false)
    if (!crossWorld.ok) assert.equal(crossWorld.code, 'INSTANCE_WORLD_MISMATCH')
  })

  it('动词与目标白名单：只允许 use / desk_01', () => {
    const { service } = makeService()
    const badVerb = service.admit({ worldId: WORLD, instanceId: INSTANCE, spec: spec({ verb: 'move' }) })
    assert.equal(badVerb.ok, false)
    if (!badVerb.ok) assert.equal(badVerb.code, 'VERB_NOT_ALLOWED')

    const badTarget = service.admit({ worldId: WORLD, instanceId: INSTANCE, spec: spec({ target: 'lamp_02' }) })
    assert.equal(badTarget.ok, false)
    if (!badTarget.ok) assert.equal(badTarget.code, 'TARGET_NOT_ALLOWED')
  })

  it('args 超限被拒绝', () => {
    const { service } = makeService()
    const huge = service.admit({
      worldId: WORLD,
      instanceId: INSTANCE,
      spec: spec({ args: { blob: 'x'.repeat(4096) } }),
    })
    assert.equal(huge.ok, false)
    if (!huge.ok) assert.equal(huge.code, 'ARGS_TOO_LARGE')
  })

  it('未配置世界时整条链路惰性', () => {
    const { service } = makeService({ worldIds: [] })
    assert.equal(service.enabled, false)
    const result = service.admit({ worldId: WORLD, instanceId: INSTANCE, spec: spec() })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'WORLD_DISABLED')
  })
})

describe('World · 领取与过期', () => {
  it('领取后进入 dispatched 且只领取一次', () => {
    const { service } = makeService()
    const action = admitOk(service)
    const leased = service.lease(WORLD, 4)
    assert.equal(leased.length, 1)
    assert.equal(leased[0]!.actionId, action.actionId)
    assert.equal(leased[0]!.status, 'dispatched')
    assert.equal(leased[0]!.narration, 'uncertain')
    assert.equal(leased[0]!.attempts, 1)
    assert.notEqual(leased[0]!.leaseExpiresAtSim, null)

    assert.equal(service.lease(WORLD, 4).length, 0, '租约期内不可重复领取')
  })

  it('从未被领取就过期 → expired，叙述许可 failed（确定没发生）', () => {
    const { service, clock } = makeService()
    const action = admitOk(service)
    clock.advance(90_000)
    service.expireStale()
    const after = service.get(action.actionId)!
    assert.equal(after.status, 'expired')
    assert.equal(narrationFor({ status: after.status, firstDispatchedAtSim: after.firstDispatchedAtSim }), 'failed')
    assert.equal(service.lease(WORLD, 4).length, 0, '过期动作不应再被派发')
  })

  it('领取过但无回执 → 先回到 pending 重试，再次超时后 expired 且叙述为 uncertain', () => {
    const { service, clock } = makeService()
    const action = admitOk(service)

    service.lease(WORLD, 4)
    clock.advance(30_000)
    service.expireStale()
    assert.equal(service.get(action.actionId)!.status, 'pending', '还有重试预算')

    clock.advance(30_000)
    service.expireStale()
    const expired = service.get(action.actionId)!
    assert.equal(expired.status, 'expired')
    assert.equal(narrationFor(expired), 'uncertain', '可能已执行，不能说"没做成"')
  })

  it('不同世界互不可见', () => {
    const { service } = makeService()
    admitOk(service)
    assert.equal(service.lease('another-world', 4).length, 0)
    assert.equal(service.list({ worldId: 'another-world' }).length, 0)
  })
})

describe('World · 回执与去重', () => {
  for (const result of ['succeeded', 'failed', 'rejected'] as const) {
    it(`result=${result} 被接受并落到动作记录`, () => {
      const { service } = makeService()
      const action = admitOk(service)
      service.lease(WORLD, 4)
      const outcome = service.ingest(WORLD, [resultEvent({ eventId: `evt_${result}`, actionId: action.actionId, result })])

      assert.deepEqual(outcome.accepted, [`evt_${result}`])
      assert.equal(outcome.rejected.length, 0)
      assert.equal(outcome.applied.actionsUpdated, 1)

      const settled = service.get(action.actionId)!
      assert.equal(settled.status, result)
      assert.equal(settled.narration, result === 'succeeded' ? 'done' : 'failed')
      assert.equal(settled.outcome?.result, result)
    })
  }

  it('回执不产生记忆、状态或提议（applied 只有 actionsUpdated）', () => {
    const { service } = makeService()
    const action = admitOk(service)
    const outcome = service.ingest(WORLD, [resultEvent({ eventId: 'evt_1', actionId: action.actionId })])
    assert.deepEqual(Object.keys(outcome.applied), ['actionsUpdated'])
  })

  it('同一 eventId 重投 → duplicates，不重复结算', () => {
    const { service } = makeService()
    const action = admitOk(service)
    const event = resultEvent({ eventId: 'evt_dup', actionId: action.actionId })
    assert.deepEqual(service.ingest(WORLD, [event]).accepted, ['evt_dup'])
    const replay = service.ingest(WORLD, [event])
    assert.deepEqual(replay.accepted, [])
    assert.deepEqual(replay.duplicates, ['evt_dup'])
    assert.equal(service.eventCount(), 1)
  })

  it('同一 actionId、不同 eventId 二次结算 → ACTION_ALREADY_SETTLED', () => {
    const { service } = makeService()
    const action = admitOk(service)
    service.ingest(WORLD, [resultEvent({ eventId: 'evt_a', actionId: action.actionId })])
    const second = service.ingest(WORLD, [resultEvent({ eventId: 'evt_b', actionId: action.actionId, result: 'failed' })])
    assert.equal(second.accepted.length, 0)
    assert.equal(second.rejected[0]!.code, 'ACTION_ALREADY_SETTLED')
    assert.equal(service.get(action.actionId)!.status, 'succeeded', '先到的结果不被覆盖')
  })

  it('未知动作、实例不匹配、世界不匹配、observation、partial 都被逐条拒绝', () => {
    const { service } = makeService()
    const action = admitOk(service)

    const unknown = service.ingest(WORLD, [resultEvent({ eventId: 'e1', actionId: 'wa_999' })])
    assert.equal(unknown.rejected[0]!.code, 'UNKNOWN_ACTION')

    const wrongInstance = service.ingest(WORLD, [
      resultEvent({ eventId: 'e2', actionId: action.actionId, instanceId: 'inst_other_world' }),
    ])
    assert.equal(wrongInstance.rejected[0]!.code, 'INSTANCE_WORLD_MISMATCH')

    const wrongWorld = service.ingest(WORLD, [
      resultEvent({ eventId: 'e3', actionId: action.actionId, worldId: 'other-world' }),
    ])
    assert.equal(wrongWorld.rejected[0]!.code, 'WORLD_MISMATCH')

    const observation = service.ingest(WORLD, [
      { ...resultEvent({ eventId: 'e4', actionId: action.actionId }), kind: 'observation', result: null },
    ])
    assert.equal(observation.rejected[0]!.code, 'UNSUPPORTED_KIND')

    const partial = service.ingest(WORLD, [
      { ...resultEvent({ eventId: 'e5', actionId: action.actionId }), result: 'partial' },
    ])
    assert.equal(partial.rejected[0]!.code, 'MALFORMED')
  })

  it('批量里单条失败不影响其它条目', () => {
    const { service } = makeService()
    const a = admitOk(service)
    const b = admitOk(service)
    const outcome = service.ingest(WORLD, [
      resultEvent({ eventId: 'ok', actionId: a.actionId, result: 'failed' }),
      resultEvent({ eventId: 'bad', actionId: 'wa_does_not_exist' }),
    ])
    assert.deepEqual(outcome.accepted, ['ok'])
    assert.equal(outcome.rejected.length, 1)
    assert.equal(service.get(a.actionId)!.status, 'failed')
    assert.equal(service.get(b.actionId)!.status, 'pending', '无关动作不受影响')
  })
})

describe('World · 非持久化（第一阶段已知限制）', () => {
  it('新的服务实例看不到旧动作（内存队列，重启即丢失）', () => {
    const first = makeService()
    admitOk(first.service)
    assert.equal(first.service.list().length, 1)

    const second = makeService()
    assert.equal(second.service.list().length, 0)
    assert.equal(second.service.persistent, false)
  })
})
