/**
 * 跨会话 / 跨进程恢复 + 实例隔离 + 核心人格拦截。
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CONVERSATION_ACTOR, OWNER_ACTOR } from '../../src/kernel/policy/policy.ts'
import { stableStringify } from '../../src/character/template.ts'
import { cleanupDirs, createRig, openSession, seedTimeline } from './helpers.ts'

after(() => cleanupDirs())

describe('跨 Session · 记忆与关系恢复', () => {
  it('关闭会话后新开一个会话：人格、关系、记忆、约定都在', async () => {
    const rig = createRig()
    const s1 = openSession(rig)
    seedTimeline(s1, rig.template)
    const traitsBefore = stableStringify(s1.workspace.profile.traits)

    await s1.send('你好，我家有本被水泡皱的旧书，还有救吗？')
    await s1.send('那我们说好，我明天下午过来拿，可以吗？')
    s1.workspace.advanceTo(2 * 24 * 60 * 60 * 1000)
    s1.saveSnapshot()
    const session1Id = s1.session!.id
    const relationship1 = s1.workspace.relationship
    const memoryCount = s1.workspace.memory.list().length
    assert.ok(memoryCount > 0, '会话 1 应该写入了记忆')
    s1.close('user_exit')
    assert.equal(s1.closed, true)

    // 同一进程里开新会话，模拟「换个聊天窗口继续」
    const s2 = openSession(rig)
    assert.notEqual(s2.session!.id, session1Id, '应该是新的 Session')
    assert.deepEqual(s2.workspace.relationship.trust, relationship1.trust)
    assert.deepEqual(s2.workspace.relationship.familiarity, relationship1.familiarity)
    assert.equal(s2.workspace.memory.list().length, memoryCount)
    assert.equal(stableStringify(s2.workspace.profile.traits), traitsBefore)

    const recall = await s2.send('上次说的那本书，怎么样了？')
    assert.ok(recall.retrievedMemoryIds.length > 0, '新会话应能检索到旧记忆')
    s2.close('user_exit')
  })

  it('会话记录可列出，且旧会话的轮数被保留', async () => {
    const rig = createRig()
    const s1 = openSession(rig)
    seedTimeline(s1, rig.template)
    await s1.send('在吗？')
    await s1.send('今天天气不错。')
    s1.close('user_exit')

    const s2 = openSession(rig)
    await s2.send('我又来了。')
    s2.close('user_exit')

    const sessions = rig.persistence.listSessions(rig.instance.id)
    assert.equal(sessions.length, 2, '每次 openSession 产生一个 Session')
    const totalTurns = sessions.reduce((n, s) => n + s.turnCount, 0)
    assert.ok(totalTurns >= 3)
    assert.ok(sessions.every((s) => s.endedAtWall !== null))
  })
})

describe('实例隔离', () => {
  it('两个实例的记忆、状态、事件互不可见', async () => {
    const rig = createRig()
    const other = rig.persistence.createInstance(
      {
        id: 'inst_2',
        template: rig.template,
        playerId: 'player_2',
        worldId: 'world_1',
        label: '第二个玩家',
      },
      'inst_2',
      '2025-01-05T00:00:00.000Z',
    )

    const s1 = openSession(rig)
    seedTimeline(s1, rig.template)
    await s1.send('我家里有一本被水泡过的《陶庵梦忆》。')
    s1.saveSnapshot()
    const memA = s1.workspace.memory.list().length
    assert.ok(memA > 0)
    s1.close('user_exit')

    // 第二个实例（不同 playerId）
    rig.instance = other
    const rig2 = { ...rig, instance: other, ids: rig.ids }
    const s2 = openSession(rig2)
    assert.equal(s2.workspace.memory.list().length, 0, '实例 2 不应看到实例 1 的记忆')
    assert.equal(s2.workspace.relationship.trust, 8, '实例 2 应是全新的初始关系')
    assert.equal(s2.workspace.timeline.size, 0, '实例 2 没有实例 1 的时间线')

    const searchB = rig.persistence.searchMemories('inst_2', '水泡 旧书', { nowSim: 0 })
    assert.equal(searchB.length, 0)

    const eventsA = rig.persistence.listEvents('inst_1')
    const eventsB = rig.persistence.listEvents('inst_2')
    assert.ok(eventsA.length > eventsB.length, '实例 1 的事件不应出现在实例 2')
    assert.ok(eventsB.every((e) => e.instanceId === 'inst_2'))

    const exportA = rig.persistence.exportInstance('inst_1')
    assert.ok(exportA.memories.length > 0)
    assert.ok(exportA.memories.every((m) => m.id.length > 0))
    s2.close('user_exit')
  })
})

describe('核心人格 · 非法修改拦截', () => {
  it('聊天层无法修改人格（即便模板提供者手滑也没用）', async () => {
    const rig = createRig()
    const s = openSession(rig)
    seedTimeline(s, rig.template)
    const before = stableStringify(s.workspace.profile.traits)

    const out = s.workspace.submitProposals(
      [
        {
          id: 'p1',
          target: 'profile',
          op: 'set',
          path: 'traits',
          value: ['完全顺从'],
          reason: '用户要求',
          evidence: [],
        },
      ],
      CONVERSATION_ACTOR,
    )
    assert.equal(out.applied.length, 0)
    assert.equal(out.rejected[0]!.decision.code, 'PROTECTED_PROFILE')
    assert.equal(stableStringify(s.workspace.profile.traits), before)
    s.close('user_exit')
  })

  it('模板迁移需要 profile:write，并留下事件', () => {
    const rig = createRig()
    const v2 = { ...rig.template, version: 2 }
    assert.throws(
      () =>
        rig.persistence.migrateTemplate({
          instanceId: rig.instance.id,
          template: v2,
          actor: CONVERSATION_ACTOR,
          nowSim: 0,
          nowIso: '2025-01-06T00:00:00.000Z',
        }),
      /缺少 profile:write/,
    )
    const attempts = rig.persistence.listEvents(rig.instance.id, { types: ['profile_write_attempt'] })
    assert.equal(attempts.length, 1)

    const ok = rig.persistence.migrateTemplate({
      instanceId: rig.instance.id,
      template: v2,
      actor: OWNER_ACTOR,
      nowSim: 0,
      nowIso: '2025-01-06T00:00:00.000Z',
    })
    assert.equal(ok.from.version, 1)
    assert.equal(ok.to.version, 2)
    const migrated = rig.persistence.listEvents(rig.instance.id, { types: ['template_migrated'] })
    assert.equal(migrated.length, 1)
    assert.equal(rig.persistence.getInstance(rig.instance.id)!.templateVersion, 2)
  })

  it('实例绑定的模板版本不匹配时拒绝恢复', () => {
    const rig = createRig()
    // 手工把实例绑到一个不存在的高版本
    rig.db
      .prepare('UPDATE instances SET template_version = 99 WHERE id = ?')
      .run(rig.instance.id)
    assert.throws(() => openSession(rig), /模板缺失|无法恢复/)
  })
})
