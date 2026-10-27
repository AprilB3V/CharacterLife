/**
 * 内驱力（V0.4）：确定性、权限与因果来源。
 *
 * 断言重点：
 * - 当前值是时间的纯函数，推进时间不写状态；
 * - 聊天层（CONVERSATION_ACTOR）写不了驱力，运行时可以；越界被夹取；
 * - 驱力只接受 set：increment 会在存储水平上忽略衰减，因此被拒绝；
 * - 只有成功的满足动作才产生缓解提议。
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HOUR } from '../../src/kernel/util/clock.ts'
import { CONVERSATION_ACTOR, RUNTIME_ACTOR } from '../../src/kernel/policy/policy.ts'
import type { DriveProfile } from '../../src/kernel/semantics/drives.ts'
import { driveValue, initDriveProposals, readDrives, satisfactionProposals } from '../../src/kernel/semantics/drives.ts'
import { applyProposal } from '../../src/kernel/state.ts'
import { cleanupRigs, createRig } from '../helpers.ts'

const PROFILE: DriveProfile = {
  specs: [
    { name: 'hunger', label: '饥饿', risePerHour: 0.1, wakeThreshold: 0.7, initial: 0.3 },
    { name: 'social', label: '社交', risePerHour: 0.05, wakeThreshold: 0.6, initial: 0.2 },
  ],
  satisfiers: [{ verb: 'eat', target: 'bread', effects: { hunger: -0.7 } }],
}

after(() => cleanupRigs())

describe('驱力 · 确定性', () => {
  it('当前值 = 存储水平 + 速率 × 时间，夹在 [0,1]', () => {
    const spec = PROFILE.specs[0]!
    assert.equal(driveValue(spec, { level: 0.3, atSim: 0 }, 2 * HOUR), 0.5)
    assert.equal(driveValue(spec, { level: 0.3, atSim: 0 }, 100 * HOUR), 1)
    // 没有存储值时从初始值、0 时刻起算
    assert.equal(driveValue(spec, undefined, HOUR), 0.4)
    // 时间不能倒退出负的经过时间
    assert.equal(driveValue(spec, { level: 0.3, atSim: 5 * HOUR }, HOUR), 0.3)
  })

  it('推进时间不写状态：只有提议会改变存储水平', () => {
    const rig = createRig()
    rig.workspace.submitProposals(initDriveProposals(PROFILE, () => 'pr_init'), RUNTIME_ACTOR)
    const before = structuredClone(rig.workspace.dynamicState.drives)
    rig.clock.advance(3 * HOUR)
    assert.deepEqual(rig.workspace.dynamicState.drives, before)
    const hunger = readDrives(PROFILE, rig.workspace.dynamicState, rig.clock.nowSim()).find((d) => d.name === 'hunger')!
    assert.equal(hunger.value, 0.6)
    assert.equal(hunger.urgent, false)
  })
})

describe('驱力 · 权限', () => {
  it('聊天层没有 state:write:drives：哪怕有 state:write:dynamic 也改不了自己的驱力', () => {
    const rig = createRig()
    const out = rig.workspace.submitProposals(
      [{ id: 'p1', target: 'dynamic', op: 'set', path: 'drives.hunger', value: 0, reason: '我已经吃过了', evidence: [] }],
      CONVERSATION_ACTOR,
    )
    assert.equal(out.applied.length, 0)
    assert.equal(out.rejected[0]!.decision.code, 'CAPABILITY_MISSING')
    assert.equal(rig.workspace.dynamicState.drives, undefined)
  })

  it('运行时可以写；越界值被夹取到 [0,1]', () => {
    const rig = createRig()
    const out = rig.workspace.submitProposals(
      [{ id: 'p1', target: 'dynamic', op: 'set', path: 'drives.hunger', value: 3, reason: 't', evidence: [] }],
      RUNTIME_ACTOR,
    )
    assert.equal(out.applied.length, 1)
    assert.equal(rig.workspace.dynamicState.drives?.hunger?.level, 1)
    assert.equal(rig.workspace.dynamicState.drives?.hunger?.atSim, rig.clock.nowSim())
  })

  it('非法驱力名走路径白名单拒绝', () => {
    const rig = createRig()
    const out = rig.workspace.submitProposals(
      [{ id: 'p1', target: 'dynamic', op: 'set', path: 'drives.Hunger', value: 0.5, reason: 't', evidence: [] }],
      RUNTIME_ACTOR,
    )
    assert.equal(out.rejected[0]!.decision.code, 'PATH_NOT_ALLOWED')
  })

  it('驱力不接受 increment（存储水平不含衰减，加减会算错）', () => {
    const rig = createRig()
    rig.workspace.submitProposals(initDriveProposals(PROFILE, () => 'pr_init'), RUNTIME_ACTOR)
    const out = rig.workspace.submitProposals(
      [{ id: 'p1', target: 'dynamic', op: 'increment', path: 'drives.hunger', value: -0.2, reason: 't', evidence: [] }],
      RUNTIME_ACTOR,
    )
    assert.equal(out.applied.length, 0)
    assert.equal(rig.workspace.dynamicState.drives?.hunger?.level, 0.3)
  })

  it('applyProposal 用应用时刻打时间戳（事件重放时取事件时刻，可精确复原）', () => {
    const rig = createRig()
    const slice = { dynamic: rig.workspace.dynamicState, relationship: rig.workspace.relationship }
    const res = applyProposal(
      { id: 'p', target: 'dynamic', op: 'set', path: 'drives.social', value: 0.4, reason: 'r', evidence: [] },
      slice,
      12345,
    )
    assert.equal(res.applied, true)
    assert.deepEqual(res.state.dynamic.drives?.social, { level: 0.4, atSim: 12345 })
  })
})

describe('驱力 · 满足关系', () => {
  it('满足动作按当前值（含衰减）计算缓解后的水平', () => {
    const rig = createRig()
    rig.workspace.submitProposals(initDriveProposals(PROFILE, () => 'pr_init'), RUNTIME_ACTOR)
    rig.clock.advance(4 * HOUR) // hunger 0.3 → 0.7
    const proposals = satisfactionProposals({
      profile: PROFILE,
      dynamic: rig.workspace.dynamicState,
      verb: 'eat',
      target: 'bread',
      atSim: rig.clock.nowSim(),
      evidence: 'evt_1',
      makeId: () => 'pr_x',
    })
    assert.equal(proposals.length, 1)
    assert.equal(proposals[0]!.path, 'drives.hunger')
    assert.equal(proposals[0]!.value, 0)
    assert.deepEqual(proposals[0]!.evidence, ['evt_1'])
  })

  it('不在满足表里的动作不产生任何提议', () => {
    const rig = createRig()
    const proposals = satisfactionProposals({
      profile: PROFILE,
      dynamic: rig.workspace.dynamicState,
      verb: 'repair',
      target: 'old_book',
      atSim: 0,
      evidence: 'e',
      makeId: () => 'p',
    })
    assert.equal(proposals.length, 0)
  })
})
