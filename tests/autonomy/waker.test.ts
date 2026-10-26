/**
 * Waker（V0.4）：什么时候唤醒 Mind，纯函数。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { WakerConfig, WakerInput } from '../../src/kernel/cycle/waker.ts'
import { decideWake } from '../../src/kernel/cycle/waker.ts'

const MIN = 60_000
const CONFIG: WakerConfig = { useDrives: true, heartbeatMs: 90 * MIN, minGapMs: 15 * MIN, driveRepeatMs: 60 * MIN, maxWakesPerHour: 6 }

function input(over: Partial<WakerInput> = {}): WakerInput {
  return {
    nowSim: 600 * MIN,
    config: CONFIG,
    drives: [{ name: 'hunger', label: '饥饿', value: 0.2, threshold: 0.7, urgent: false }],
    lastWakeSim: 580 * MIN,
    lastDriveWakeSim: {},
    recentWakes: [],
    actionInFlight: false,
    newOutcomes: [],
    newSalient: [],
    dueCommitments: [],
    ...over,
  }
}

const URGENT = [{ name: 'hunger', label: '饥饿', value: 0.8, threshold: 0.7, urgent: true }]

describe('Waker', () => {
  it('第一次总会醒（heartbeat:first）', () => {
    const d = decideWake(input({ lastWakeSim: null }))
    assert.equal(d.wake, true)
    assert.deepEqual(d.reasons, [{ kind: 'heartbeat', detail: 'first' }])
  })

  it('没有任何原因时不醒，并说明原因', () => {
    const d = decideWake(input())
    assert.equal(d.wake, false)
    assert.equal(d.suppressedBy, 'nothing_to_do')
  })

  it('驱力越过阈值 → 醒；对照组（useDrives=false）不会因驱力醒', () => {
    assert.deepEqual(decideWake(input({ drives: URGENT })).reasons, [{ kind: 'drive', detail: 'hunger' }])
    const control = decideWake(input({ drives: URGENT, config: { ...CONFIG, useDrives: false } }))
    assert.equal(control.wake, false)
  })

  it('同一驱力在 driveRepeatMs 内不重复唤醒', () => {
    const d = decideWake(input({ drives: URGENT, lastDriveWakeSim: { hunger: 570 * MIN } }))
    assert.equal(d.wake, false)
  })

  it('自己的动作还在执行时不醒（等结果，不另起炉灶）', () => {
    const d = decideWake(input({ drives: URGENT, newOutcomes: ['wa_1'], actionInFlight: true }))
    assert.equal(d.wake, false)
    assert.equal(d.suppressedBy, 'action_in_flight')
  })

  it('最小间隔内只有 outcome 能唤醒', () => {
    const recent = input({ lastWakeSim: 595 * MIN, drives: URGENT, newSalient: ['npc_arrived:npc_lin'] })
    assert.equal(decideWake(recent).wake, false)
    const withOutcome = decideWake({ ...recent, newOutcomes: ['wa_9'] })
    assert.equal(withOutcome.wake, true)
    assert.deepEqual(withOutcome.reasons, [{ kind: 'outcome', detail: 'wa_9' }])
  })

  it('每小时预算用完后什么都唤不醒', () => {
    const wakes = [550, 560, 570, 580, 590, 599].map((m) => m * MIN)
    const d = decideWake(input({ recentWakes: wakes, newOutcomes: ['wa_1'] }))
    assert.equal(d.wake, false)
    assert.match(d.suppressedBy ?? '', /^budget/)
  })

  it('长时间没醒 → heartbeat', () => {
    const d = decideWake(input({ lastWakeSim: 500 * MIN }))
    assert.equal(d.wake, true)
    assert.equal(d.reasons[0]!.kind, 'heartbeat')
  })
})
