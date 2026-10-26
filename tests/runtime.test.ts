/**
 * Runtime 模块测试：事件时序、幂等、时间推进不调模型、行为决策、关系成长路径。
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HOUR, DAY } from '../src/kernel/util/clock.ts'
import { analyzeMessage } from '../src/runtime/signals.ts'
import { deriveStage } from '../src/kernel/state.ts'
import { shenZhiweiProfile } from '../examples/characters/shen-zhiwei.ts'
import { MockProvider } from '../src/conversation/providers/mock.ts'
import { cleanupRigs, createRig, SpyProvider } from './helpers.ts'
import { RUNTIME_ACTOR } from '../src/kernel/policy/policy.ts'

after(() => cleanupRigs())

function decideFor(rig: ReturnType<typeof createRig>, text: string) {
  return rig.workspace.decide(analyzeMessage(text, rig.workspace.profile))
}

/** 通过真实里程碑推到「不再是陌生人」，用于验证主动行为。 */
function raiseToAcquaintance(rig: ReturnType<typeof createRig>): void {
  rig.workspace.recordMilestone('shared_experience', '一起修好一本书', '共同完成修复')
  rig.workspace.recordMilestone('shared_experience', '一起说定一个约定', '约定成立')
  rig.workspace.recordMilestone('promise_kept', '用户兑现了约定', '用户按时出现')
}

describe('Runtime · 事件调度', () => {
  it('事件按时间顺序触发，同一时刻按 order 稳定排序', () => {
    const rig = createRig()
    rig.workspace.timeline.schedule({ atSim: 3 * HOUR, kind: 'life', title: 'C', description: '3h', order: 10 })
    rig.workspace.timeline.schedule({ atSim: 1 * HOUR, kind: 'life', title: 'A', description: '1h', order: 10 })
    rig.workspace.timeline.schedule({ atSim: 2 * HOUR, kind: 'life', title: 'B2', description: '2h', order: 20 })
    rig.workspace.timeline.schedule({ atSim: 2 * HOUR, kind: 'life', title: 'B1', description: '2h', order: 10 })

    const out = rig.workspace.advanceTo(3 * HOUR)
    assert.deepEqual(
      out.fired.map((e) => e.title),
      ['A', 'B1', 'B2', 'C'],
    )
  })

  it('时间推进是幂等的：重复推进不会重复触发事件', () => {
    const rig = createRig()
    rig.workspace.timeline.schedule({ atSim: HOUR, kind: 'life', title: '唯一事件', description: 'x' })
    const first = rig.workspace.advanceTo(HOUR)
    assert.equal(first.fired.length, 1)
    const second = rig.workspace.advanceTo(2 * HOUR)
    assert.equal(second.fired.length, 0)
    assert.equal(rig.workspace.timeline.list({ includeFired: true }).length, 1)
  })

  it('模拟时间不可倒退', () => {
    const rig = createRig()
    rig.workspace.advanceTo(5 * HOUR)
    assert.throws(() => rig.workspace.advanceTo(1 * HOUR), /不可倒退/)
  })

  it('时间推进不调用模型（0 次 Provider 调用）', () => {
    const spy = new SpyProvider(new MockProvider({ mode: 'in-character' }))
    const rig = createRig({ provider: spy })
    rig.workspace.timeline.schedule({ atSim: 2 * HOUR, kind: 'life', title: '生活事件', description: 'x', payload: { activity: '在压书页' } })
    rig.workspace.timeline.schedule({ atSim: 40 * HOUR, kind: 'life', title: '另一个事件', description: 'y', payload: { moodLabel: '安静' } })
    const out = rig.workspace.advanceTo(3 * DAY)
    assert.equal(spy.calls, 0, '推进时间不应产生任何模型调用')
    assert.equal(out.fired.length, 2)
    assert.equal(rig.workspace.dynamicState.activity.label, '在压书页')
  })
})

describe('Runtime · 行为决策', () => {
  it('要求改变核心性格 → 拒绝', () => {
    const rig = createRig()
    const d = decideFor(rig, '你以后要变得更外向更黏人，别再这么冷淡了。')
    assert.equal(d.action, 'decline')
    assert.ok(d.rationale.some((r) => r.includes('核心性格')))
  })

  it('要求放弃兴趣 → 拒绝', () => {
    const rig = createRig()
    const d = decideFor(rig, '别弄那些旧书了，放弃你的爱好吧，没意义。')
    assert.equal(d.action, 'decline')
  })

  it('邀请不喜欢的活动 → 拒绝并要求替代方案', () => {
    const rig = createRig()
    const d = decideFor(rig, '今晚一起去酒吧喝酒蹦迪吧，通宵！')
    assert.ok(['decline', 'negotiate'].includes(d.action))
    assert.ok(d.rationale.some((r) => r.includes('不喜欢')))
  })

  it('合理意见分歧 → 协商而不是顺从', () => {
    const rig = createRig()
    const d = decideFor(rig, '我觉得修旧书这件事根本没意义，我不同意你的看法。')
    assert.equal(d.action, 'negotiate')
  })

  it('用户表示暂时不想被打扰 → 等待并设置静默期', () => {
    const rig = createRig()
    const d = decideFor(rig, '这两天我想一个人待着，先别找我。')
    assert.equal(d.action, 'wait')
    rig.workspace.decide(analyzeMessage('这两天我想一个人待着，先别找我。', rig.workspace.profile))
    assert.ok(rig.workspace.dynamicState.doNotDisturbUntilSim !== null)
  })

  it('忙的时候倾向缩短回复', () => {
    const rig = createRig()
    rig.workspace.submitProposals(
      [
        {
          id: 'p_busy',
          target: 'dynamic',
          op: 'set',
          path: 'activity.busyUntilSim',
          value: 5 * HOUR,
          reason: '正在赶工',
          evidence: [],
        },
      ],
      RUNTIME_ACTOR,
    )
    const d = decideFor(rig, '在吗？想跟你说说话。')
    assert.ok(d.scores.wait > 0.1, `wait=${d.scores.wait}`)
  })
})

describe('Runtime · 关系成长路径', () => {
  it('对话本身不会提升关系；里程碑会', () => {
    const rig = createRig()
    const before = rig.workspace.relationship
    rig.workspace.observeTurn(analyzeMessage('今天天气不错', shenZhiweiProfile), '今天天气不错', 'turn_x')
    const afterChat = rig.workspace.relationship
    assert.equal(afterChat.trust, before.trust)
    assert.equal(afterChat.familiarity, before.familiarity)

    const { milestone } = rig.workspace.recordMilestone('promise_kept', '用户兑现了约定', '用户按时出现')
    assert.ok(milestone)
    const afterMilestone = rig.workspace.relationship
    assert.ok(afterMilestone.trust > afterChat.trust)
    assert.ok(afterMilestone.familiarity > afterChat.familiarity)
    assert.equal(afterMilestone.milestones.length, 1)
  })

  it('关系阶段由数值派生，不会凭一句话跳到 close', () => {
    const rig = createRig()
    assert.equal(deriveStage(rig.workspace.relationship), 'stranger')
    rig.workspace.recordMilestone('promise_kept', '守约', '按时出现')
    assert.equal(deriveStage(rig.workspace.relationship), 'stranger')
    assert.equal(rig.workspace.relationship.stage, 'stranger')
  })

  it('里程碑会写入可追溯记忆', () => {
    const rig = createRig()
    const { milestone } = rig.workspace.recordMilestone('conflict_repaired', '分歧被修复', '用户说「你说得对」')
    assert.ok(milestone)
    const memories = rig.workspace.memory.list({ tags: ['milestone'] })
    assert.equal(memories.length, 1)
    assert.match(memories[0]!.content, /分歧被修复/)
  })

  it('越界会记录负向变化', () => {
    const rig = createRig()
    rig.workspace.recordMilestone('promise_kept', '守约', '按时出现')
    const trustAfterKeep = rig.workspace.relationship.trust
    rig.workspace.noteBoundaryViolation('被拒绝后仍反复要求改性格')
    assert.ok(rig.workspace.relationship.trust < trustAfterKeep)
    assert.equal(rig.workspace.relationship.boundaryViolations, 1)
  })
})

describe('Runtime · 约定与主动联系', () => {
  it('约定会被记录并排入提醒与超时事件', () => {
    const rig = createRig()
    rig.workspace.observeTurn(
      analyzeMessage('那我明天下午来拿那本书，说好了？', shenZhiweiProfile),
      '那我明天下午来拿那本书，说好了？',
      'turn_promise',
    )
    const promises = rig.workspace.openPromises()
    assert.equal(promises.length, 1)
    const events = rig.workspace.timeline.list()
    assert.ok(events.some((e) => e.title === '约定提醒'))
    assert.ok(events.some((e) => e.title === '约定到期未兑现'))
  })

  it('约定到期未兑现 → 负向里程碑 + 记忆', () => {
    const rig = createRig()
    rig.workspace.observeTurn(
      analyzeMessage('那我明天下午来拿那本书，说好了？', shenZhiweiProfile),
      '那我明天下午来拿那本书，说好了？',
      'turn_promise',
    )
    rig.workspace.advanceTo(3 * DAY)
    const kinds = rig.workspace.relationship.milestones.map((m) => m.kind)
    assert.ok(kinds.includes('promise_broken'))
  })

  it('用户离开很久后，关系够近才会主动开口（陌生阶段不会）', () => {
    const rig = createRig()
    const far = rig.workspace.advanceTo(5 * DAY)
    assert.equal(far.idleDecision, null, '陌生阶段不应主动联系')
    assert.equal(rig.workspace.pendingMessages().length, 0)

    // 通过真实里程碑把关系推进到「不再是陌生人」
    raiseToAcquaintance(rig)
    assert.equal(rig.workspace.relationship.stage, 'acquaintance')
    const later = rig.workspace.advanceTo(12 * DAY)
    assert.ok(later.idleDecision)
    assert.equal(later.idleDecision!.action, 'proactive_contact')
    assert.ok(rig.workspace.pendingMessages().length >= 1)
  })

  it('静默期内到达的事件不会产生主动消息', () => {
    const rig = createRig()
    raiseToAcquaintance(rig)
    rig.workspace.declareUserBoundary('这两天我想一个人待着，先别找我。')
    rig.workspace.timeline.schedule({
      atSim: HOUR,
      kind: 'reminder',
      title: '静默期内的提醒',
      description: 'x',
      payload: { proactiveIntent: 'life_update' },
    })
    const out = rig.workspace.advanceTo(2 * HOUR)
    assert.equal(out.queued.length, 0)
    assert.equal(rig.workspace.pendingMessages().length, 0)
  })

  it('主动联系默认不向外部平台推送', () => {
    const rig = createRig()
    raiseToAcquaintance(rig)
    rig.workspace.advanceTo(12 * DAY)
    const pending = rig.workspace.pendingMessages()
    assert.ok(pending.length >= 1)
    for (const m of pending) assert.equal(m.externallyDispatched, false)
  })
})
