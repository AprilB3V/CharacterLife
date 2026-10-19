/**
 * 状态恢复与事件重放的确定性。
 *
 * 断言两件事：
 * 1. 从同一份数据恢复两次，得到逐字节相同的状态指纹；
 * 2. 「旧快照 + 之后的所有补丁事件」重放出来的状态，与当前内存状态完全一致。
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CharacterPersistence } from '../../src/persistence/store.ts'
import { replayState } from '../../src/character/rehydration.ts'
import { stableStringify } from '../../src/character/template.ts'
import { cleanupDirs, createRig, openSession, seedTimeline } from './helpers.ts'

after(() => cleanupDirs())

describe('事件重放 · 确定性', () => {
  it('旧快照 + 后续补丁 = 当前状态', async () => {
    const rig = createRig()
    const s = openSession(rig)
    seedTimeline(s, rig.template)
    await s.send('你好，我有一本被水泡过的书。')
    await s.send('那我们约定明天下午见，说好了。')
    s.saveSnapshot()
    const snapshotA = rig.persistence.latestSnapshot(rig.instance.id)!
    assert.ok(snapshotA)

    // 继续产生状态变更与时间线事件
    await s.send('我今天有点忙，改天再聊。')
    s.workspace.advanceTo(2 * 24 * 60 * 60 * 1000)
    s.workspace.recordMilestone('promise_kept', '用户后来又来了', '用户次日出现')
    s.saveSnapshot()

    const after = rig.persistence.listEvents(rig.instance.id, { afterSeq: snapshotA.lastEventSeq })
    assert.ok(after.length > 0, '快照之后应有事件')
    const replayed = replayState(snapshotA.state, after)
    const current = s.workspace.dumpState()

    const fpReplay = CharacterPersistence.fingerprint({
      relationship: replayed.relationship,
      dynamic: replayed.dynamic,
      timeline: replayed.timeline,
    })
    const fpCurrent = CharacterPersistence.fingerprint({
      relationship: current.relationship,
      dynamic: current.dynamic,
      timeline: current.timeline,
    })
    assert.equal(fpReplay, fpCurrent, '重放结果必须与当前状态逐字段一致')
    assert.ok(replayed.applied >= 3, `至少应用了 3 个补丁事件，实际 ${replayed.applied}`)
    s.close('user_exit')
  })

  it('同一份数据恢复两次，状态指纹完全相同', () => {
    const rig = createRig()
    const a = openSession(rig)
    seedTimeline(a, rig.template)
    a.workspace.advanceTo(2 * 24 * 60 * 60 * 1000)
    a.saveSnapshot()
    const fingerprint = CharacterPersistence.fingerprint({
      relationship: a.workspace.relationship,
      dynamic: a.workspace.dynamicState,
      timeline: a.workspace.timeline.list(),
    })
    a.close('user_exit')

    const b = openSession(rig)
    const fpB = CharacterPersistence.fingerprint({
      relationship: b.workspace.relationship,
      dynamic: b.workspace.dynamicState,
      timeline: b.workspace.timeline.list(),
    })
    b.close('user_exit')

    const c = openSession(rig)
    const fpC = CharacterPersistence.fingerprint({
      relationship: c.workspace.relationship,
      dynamic: c.workspace.dynamicState,
      timeline: c.workspace.timeline.list(),
    })
    c.close('user_exit')

    assert.equal(fpB, fingerprint)
    assert.equal(fpC, fingerprint)
  })

  it('损坏的事件被跳过并计数，不会让恢复崩溃', async () => {
    const rig = createRig()
    const s = openSession(rig)
    seedTimeline(s, rig.template)
    await s.send('你好。')
    s.saveSnapshot()
    s.close('user_exit')

    // 手工塞入非法补丁：target 不认识 / 缺少 path
    rig.persistence.appendEvent({
      instanceId: rig.instance.id,
      sessionId: null,
      type: 'state_patch',
      atSim: 0,
      atWall: '2025-01-06T00:00:00.000Z',
      actor: 'test',
      summary: '损坏的补丁',
      data: {
        source: 'test',
        proposals: [
          { target: 'nonsense', op: 'set', path: 'x', value: 1, reason: '', evidence: [] },
          { target: 'dynamic', op: 'set', path: '', value: 1, reason: '', evidence: [] },
          { target: 'dynamic', op: 'set', path: 'mood.label', value: '平静', reason: 'ok', evidence: [] },
        ],
      },
    })

    const s2 = openSession(rig)
    assert.ok(s2.report.invalidEvents >= 2, `实际非法事件 ${s2.report.invalidEvents}`)
    assert.equal(s2.report.steps[3]!.ok, false, '第 4 步应标记为有问题')
    assert.ok(s2.workspace.dynamicState.mood.label.length > 0, '合法补丁仍然生效')
    s2.close('user_exit')
  })

  it('快照与事件序号对齐：重放后不再重复触发时间线事件', async () => {
    const rig = createRig()
    const s = openSession(rig)
    seedTimeline(s, rig.template)
    const first = s.workspace.advanceTo(24 * 60 * 60 * 1000)
    assert.ok(first.fired.length > 0)
    s.saveSnapshot()
    s.close('user_exit')

    const s2 = openSession(rig)
    const again = s2.workspace.advanceTo(24 * 60 * 60 * 1000)
    assert.equal(again.fired.length, 0, '已触发的事件不应重复触发')
    s2.close('user_exit')
  })

  it('状态指纹对键顺序不敏感（同一个对象重排仍相等）', () => {
    const rig = createRig()
    const s = openSession(rig)
    const rel = s.workspace.relationship
    const reordered = { ...rel, boundaries: [...rel.boundaries].reverse() }
    const a = stableStringify({ x: 1, y: 2 })
    const b = stableStringify({ y: 2, x: 1 })
    assert.equal(a, b)
    // 数组顺序敏感（这是正确行为）
    assert.notEqual(
      stableStringify(rel.boundaries),
      stableStringify(reordered.boundaries.length > 1 ? reordered.boundaries : rel.boundaries),
    )
  })
})
