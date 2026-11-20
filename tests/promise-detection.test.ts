import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeMessage } from '../src/runtime/signals.ts'
import { parseDueAtSim } from '../src/runtime/workspace.ts'
import { DAY, HOUR } from '../src/kernel/util/clock.ts'
import { shenZhiweiProfile } from '../examples/characters/shen-zhiwei.ts'
import { createRig, cleanupRigs } from './helpers.ts'

// Agenda v1 review (2026-11-20): a recall question became a promise; a promise with a clock time
// between the time word and the verb was missed and got a two-day default due time.

test.after(() => cleanupRigs())

const promise = (text: string) => analyzeMessage(text, shenZhiweiProfile).promiseText

test('promise detection: clock time between the time word and the verb', () => {
    assert.ok(promise('今晚八点我过来找你，顺便带点茶叶。'))
    assert.ok(promise('明天下午三点我们去河边走走'))
    assert.ok(promise('明天一起去吧'), 'old patterns still fire')
    // Not recall questions: a new promise that happens to contain 记得 / 什么.
    assert.ok(promise('约好了明天去公园，记得带伞'))
    assert.ok(promise('说好了，明天我给你带点什么吃的'))
})

test('not a new promise: recall questions and past narration', () => {
    assert.equal(promise('我们之前约好了什么来着？'), null)
    assert.equal(promise('你还记得我们说好的事吗？'), null)
    assert.equal(promise('今晚八点我不过来，你别等我'), null)
    assert.equal(promise('下午我去买菜了'), null)
    assert.equal(promise('早上我去了趟菜市场'), null)
    assert.equal(promise('下午我过来过一次，你不在'), null)
})

test('parseDueAtSim: clock times, parts of day, day words', () => {
    const now = 10 * HOUR
    assert.equal(parseDueAtSim('今晚八点见', now), 20 * HOUR)
    assert.equal(parseDueAtSim('晚上7点半', now), 19.5 * HOUR)
    assert.equal(parseDueAtSim('中午一点', now), 13 * HOUR)
    assert.equal(parseDueAtSim('明天上午十点', now), DAY + 10 * HOUR)
    assert.equal(parseDueAtSim('后天下午两点', now), 2 * DAY + 14 * HOUR)
    assert.equal(parseDueAtSim('早上九点', now), DAY + 9 * HOUR, 'a past time with no day word means tomorrow')
    assert.equal(parseDueAtSim('十二点', now), 12 * HOUR)
    assert.equal(parseDueAtSim('明天见', now), null)
    assert.equal(parseDueAtSim('今晚十二点半见', now), DAY + 0.5 * HOUR, 'midnight, not noon')
    assert.equal(parseDueAtSim('晚上12点', now), DAY)
    assert.equal(parseDueAtSim('明天第三点我来讲', now), null, 'an ordinal is not a clock time')
    assert.equal(parseDueAtSim('周末下午三点我来找你', now), null, 'week-scale words fall back to the day offset')
})

test('a chat promise with a clock time is tracked with that due time', async () => {
    const rig = createRig({ startSim: 10 * HOUR })
    await rig.service.send('今晚八点我过来找你，给你带点茶叶，好吗')
    const open = rig.workspace.openPromises()
    assert.equal(open.length, 1)
    assert.equal(open[0]!.dueAtSim, 20 * HOUR)
    await rig.service.send('我们约好了什么来着？')
    assert.equal(rig.workspace.openPromises().length, 1, 'the recall question adds nothing')
})
