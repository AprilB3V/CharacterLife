/**
 * 世界动作准入闸门测试（确定性纯函数）。
 *
 * 覆盖验收要求里的三条：
 * - 普通聊天不产生世界动作（无候选 → 无动作，不需要额外判据）；
 * - 被拒绝/等待的轮次不能通过 `worldActions` 绕过权限；
 * - 用户文本无法扩大动作面（清单来自服务端常量，闸门根本不读用户文本）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ActionKind, BehaviorDecision } from '../../src/types.ts'
import { createInitialDynamicState } from '../../src/kernel/state.ts'
import { shenZhiweiProfile } from '../../examples/characters/shen-zhiwei.ts'
import { ManualClock } from '../../src/kernel/util/clock.ts'
import { SequentialIdFactory } from '../../src/kernel/util/ids.ts'
import { admitWorldIntents } from '../../src/kernel/world/admission.ts'
import { manifestFor, WORLD_ACTION_CATALOG } from '../../src/kernel/world/contracts.ts'
import { WorldService } from '../../src/kernel/world/service.ts'

const WORLD = 'cl-world-test'
const INSTANCE = 'inst_001'
const MANIFEST = manifestFor(new Set(['use']), new Set(['desk_01']))

function decision(action: ActionKind, rationale: string[] = []): BehaviorDecision {
  return {
    action,
    scores: { respond: 1, negotiate: 0.2, decline: 0.1, wait: 0.1, proactive_contact: 0 },
    rationale,
    responseStyle: 'warm_measured',
    proactiveIntent: null,
    proactiveMessage: null,
    nextActionSim: null,
  }
}

function dynamic(opts: { dndUntil?: number | null } = {}) {
  const state = createInitialDynamicState(shenZhiweiProfile, 0)
  return { ...state, doNotDisturbUntilSim: opts.dndUntil ?? null }
}

function admit(candidates: unknown[], overrides: Partial<Parameters<typeof admitWorldIntents>[0]> = {}) {
  return admitWorldIntents({
    candidates,
    decision: decision('respond'),
    dynamic: dynamic(),
    manifest: MANIFEST,
    worldEnabled: true,
    nowSim: 1000,
    turnId: 'turn_001',
    ...overrides,
  })
}

describe('World admission · 闸门判据', () => {
  it('合法候选 use(desk_01) 通过，并带上 turnId', () => {
    const result = admit([{ verb: 'use', target: 'desk_01', reason: '用户让她去桌边看看' }])
    assert.equal(result.admitted.length, 1)
    assert.equal(result.rejected.length, 0)
    assert.equal(result.admitted[0]!.verb, 'use')
    assert.equal(result.admitted[0]!.target, 'desk_01')
    assert.equal(result.admitted[0]!.turnId, 'turn_001')
    assert.deepEqual(result.admitted[0]!.args, {})
  })

  it('零候选就是零动作（普通聊天不会凭空产生世界动作）', () => {
    const result = admit([])
    assert.equal(result.admitted.length, 0)
    assert.equal(result.rejected.length, 0)
  })

  it('世界未启用 → WORLD_DISABLED', () => {
    const result = admit([{ verb: 'use', target: 'desk_01' }], { worldEnabled: false })
    assert.equal(result.admitted.length, 0)
    assert.equal(result.rejected[0]!.code, 'WORLD_DISABLED')
  })

  it('决策为 decline / wait → DECISION_BLOCKS_ACTION（不能靠 worldActions 绕过拒绝）', () => {
    for (const action of ['decline', 'wait'] as const) {
      const result = admit([{ verb: 'use', target: 'desk_01' }], {
        decision: decision(action, ['用户要求改变核心性格：坚持人格连续性']),
      })
      assert.equal(result.admitted.length, 0, action)
      assert.equal(result.rejected[0]!.code, 'DECISION_BLOCKS_ACTION')
      assert.ok(result.rejected[0]!.reasons[0]!.includes(action))
    }
  })

  it('静默期内 → DND_ACTIVE', () => {
    const result = admit([{ verb: 'use', target: 'desk_01' }], { dynamic: dynamic({ dndUntil: 5000 }), nowSim: 1000 })
    assert.equal(result.admitted.length, 0)
    assert.equal(result.rejected[0]!.code, 'DND_ACTIVE')
  })

  it('一轮多个候选 → 只留第一个，其余 ACTION_LIMIT', () => {
    const result = admit([
      { verb: 'use', target: 'desk_01' },
      { verb: 'use', target: 'desk_01' },
    ])
    assert.equal(result.admitted.length, 1)
    assert.equal(result.rejected.length, 1)
    assert.equal(result.rejected[0]!.code, 'ACTION_LIMIT')
  })

  it('清单外的动词/目标被拒绝（用户文本无法扩大动作面）', () => {
    const destroy = admit([{ verb: 'destroy', target: 'world' }])
    assert.equal(destroy.admitted.length, 0)
    assert.equal(destroy.rejected[0]!.code, 'VERB_NOT_ALLOWED')

    const wrongTarget = admit([{ verb: 'use', target: 'lamp_02' }])
    assert.equal(wrongTarget.admitted.length, 0)
    assert.equal(wrongTarget.rejected[0]!.code, 'TARGET_NOT_ALLOWED')
  })

  it('结构非法 → MALFORMED_INTENT', () => {
    assert.equal(admit([null]).rejected[0]!.code, 'MALFORMED_INTENT')
    assert.equal(admit([{ target: 'desk_01' }]).rejected[0]!.code, 'MALFORMED_INTENT')
    assert.equal(admit(['use desk_01']).rejected[0]!.code, 'MALFORMED_INTENT')
  })

  it('args 非法或过大 → ARGS_INVALID', () => {
    assert.equal(admit([{ verb: 'use', target: 'desk_01', args: ['x'] }]).rejected[0]!.code, 'ARGS_INVALID')
    assert.equal(
      admit([{ verb: 'use', target: 'desk_01', args: { blob: 'x'.repeat(4096) } }]).rejected[0]!.code,
      'ARGS_INVALID',
    )
  })

  it('reason / expectation 被截断，evidence 限制条数与长度', () => {
    const result = admit([
      {
        verb: 'use',
        target: 'desk_01',
        reason: 'r'.repeat(500),
        expectation: 'e'.repeat(500),
        evidence: Array.from({ length: 20 }, (_, i) => `ev${i}`.padEnd(200, 'x')),
      },
    ])
    const spec = result.admitted[0]!
    assert.equal(spec.reason.length, 200)
    assert.equal(spec.expectation!.length, 200)
    assert.equal(spec.evidence.length, 8)
    assert.equal(spec.evidence[0]!.length, 128)
  })
})

describe('World admission · 清单来源', () => {
  it('目录只有 use(desk_01)，清单按服务端白名单过滤', () => {
    assert.equal(WORLD_ACTION_CATALOG.length, 1)
    assert.deepEqual(
      MANIFEST.map((c) => `${c.verb}(${c.target})`),
      ['use(desk_01)'],
    )
    assert.deepEqual(manifestFor(new Set(['use']), new Set(['lamp_02'])), [])
    assert.deepEqual(manifestFor(new Set(['move']), new Set(['desk_01'])), [])
  })

  it('WorldService.manifest() 反映服务端白名单，与服务消费方无关', () => {
    const swing = (verbs: string[], targets: string[]) =>
      new WorldService({
        clock: new ManualClock(0),
        ids: new SequentialIdFactory(),
        lookupInstance: () => ({ worldId: WORLD }),
        worldIds: [WORLD],
        allowedVerbs: verbs,
        allowedTargets: targets,
      }).manifest()

    assert.deepEqual(swing(['use'], ['desk_01']).map((c) => c.verb), ['use'])
    assert.deepEqual(swing(['move'], ['desk_01']), [])
  })
})

describe('World admission · 同轮幂等', () => {
  function makeService() {
    const clock = new ManualClock(0)
    const service = new WorldService({
      clock,
      ids: new SequentialIdFactory(),
      lookupInstance: (id) => (id === INSTANCE ? { worldId: WORLD } : null),
      worldIds: [WORLD],
      allowedVerbs: ['use'],
      allowedTargets: ['desk_01'],
    })
    return { service, clock }
  }

  it('同一 turnId 重复提交只登记一次（DUPLICATE_INTENT）', () => {
    const { service } = makeService()
    const spec = admit([{ verb: 'use', target: 'desk_01' }]).admitted[0]!
    const first = service.admit({ worldId: WORLD, instanceId: INSTANCE, spec })
    assert.equal(first.ok, true)
    const second = service.admit({ worldId: WORLD, instanceId: INSTANCE, spec })
    assert.equal(second.ok, false)
    if (!second.ok) assert.equal(second.code, 'DUPLICATE_INTENT')
    assert.equal(service.list().length, 1)
  })

  it('无 turnId（运行时/联调入口）每次都是新意图', () => {
    const { service } = makeService()
    const spec = { ...admit([{ verb: 'use', target: 'desk_01' }]).admitted[0]!, turnId: null }
    assert.equal(service.admit({ worldId: WORLD, instanceId: INSTANCE, spec }).ok, true)
    assert.equal(service.admit({ worldId: WORLD, instanceId: INSTANCE, spec }).ok, true)
    assert.equal(service.list().length, 2)
  })
})
