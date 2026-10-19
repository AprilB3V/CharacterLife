/**
 * 持久化测试：快照原子写入、重启恢复、时间线与事件不重复触发、损坏数据的安全失败。
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { HOUR, DAY } from '../src/util/clock.ts'
import { SnapshotStore } from '../src/storage/snapshot.ts'
import { analyzeMessage } from '../src/runtime/signals.ts'
import { shenZhiweiProfile } from '../examples/characters/shen-zhiwei.ts'
import { cleanupRigs, createRig, makeDir, reopenRig } from './helpers.ts'

after(() => cleanupRigs())

describe('持久化 · 重启恢复', () => {
  it('关系、记忆、里程碑与约定在重启后完整恢复', () => {
    const rig = createRig()
    rig.workspace.recordMilestone('promise_kept', '用户兑现了约定', '按时出现')
    rig.workspace.writeMemory(
      {
        kind: 'episodic',
        title: '重要记忆',
        content: '用户带了一本被水泡过的家书来',
        status: 'fact',
        origin: 'user_message',
        salience: 0.95,
      },
      { id: 'runtime', label: 'r', capabilities: new Set(['memory:write']) } as never,
    )
    rig.workspace.observeTurn(
      analyzeMessage('明天下午我来拿书，说好了', shenZhiweiProfile),
      '明天下午我来拿书，说好了',
      'turn_1',
    )
    rig.workspace.advanceTo(2 * HOUR)
    rig.workspace.save()

    const before = {
      trust: rig.workspace.relationship.trust,
      familiarity: rig.workspace.relationship.familiarity,
      milestones: rig.workspace.relationship.milestones.length,
      memories: rig.workspace.view().memory.total,
      pending: rig.workspace.pendingMessages().length,
      sim: rig.clock.nowSim(),
    }

    const rig2 = reopenRig(rig)
    assert.equal(rig2.restored, true)
    assert.equal(rig2.workspace.relationship.trust, before.trust)
    assert.equal(rig2.workspace.relationship.familiarity, before.familiarity)
    assert.equal(rig2.workspace.relationship.milestones.length, before.milestones)
    assert.equal(rig2.workspace.view().memory.total, before.memories)
    assert.equal(rig2.workspace.pendingMessages().length, before.pending)
    assert.equal(rig2.clock.nowSim(), before.sim, '模拟时间应从保存处继续')
  })

  it('重启后不会重复触发已发生的事件', () => {
    const rig = createRig()
    rig.workspace.timeline.schedule({ atSim: HOUR, kind: 'life', title: '早事件', description: 'x' })
    rig.workspace.timeline.schedule({ atSim: 3 * HOUR, kind: 'life', title: '晚事件', description: 'y' })
    const first = rig.workspace.advanceTo(2 * HOUR)
    assert.equal(first.fired.length, 1)
    rig.workspace.save()

    const rig2 = reopenRig(rig)
    const second = rig2.workspace.advanceTo(4 * HOUR)
    assert.deepEqual(
      second.fired.map((e) => e.title),
      ['晚事件'],
      '只应触发尚未触发的那一个',
    )
    assert.equal(rig2.workspace.timeline.list().filter((e) => e.fired).length, 2)
  })

  it('快照是原子写入的合法 JSON', () => {
    const rig = createRig()
    rig.workspace.save()
    const file = join(rig.dir, 'snapshot.json')
    assert.ok(existsSync(file))
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    assert.ok(parsed.__meta)
    assert.ok(parsed.memory)
    assert.ok(parsed.timeline)
    assert.ok(parsed.runtime)
  })

  it('时间线推进跨重启后仍然单调', () => {
    const rig = createRig()
    rig.workspace.advanceTo(DAY)
    rig.workspace.save()
    const rig2 = reopenRig(rig)
    assert.throws(() => rig2.workspace.advanceTo(HOUR), /不可倒退/)
  })
})

describe('持久化 · 安全失败', () => {
  it('schemaVersion 不兼容时显式报错', () => {
    const dir = makeDir()
    const file = join(dir, 'snapshot.json')
    writeFileSync(file, JSON.stringify({ __meta: { schemaVersion: 99, savedAtSim: 0, savedAtWall: 'x' } }), 'utf8')
    const store = new SnapshotStore(file, 1)
    assert.throws(() => store.load(), /schemaVersion=99/)
  })

  it('快照损坏时报错而不是静默使用坏数据', () => {
    const dir = makeDir()
    const file = join(dir, 'snapshot.json')
    writeFileSync(file, '{ 这不是 JSON ', 'utf8')
    const store = new SnapshotStore(file, 1)
    assert.throws(() => store.load(), /不是合法 JSON/)
  })

  it('缺少 section 时报错', () => {
    const dir = makeDir()
    const file = join(dir, 'snapshot.json')
    writeFileSync(file, JSON.stringify({ __meta: { schemaVersion: 1, savedAtSim: 0, savedAtWall: 'x' } }), 'utf8')
    const store = new SnapshotStore(file, 1)
    store.register({
      sectionName: 'memory',
      toJSON: () => ({}),
      fromJSON: () => {},
    })
    assert.throws(() => store.load(), /缺少 section: memory/)
  })
})
