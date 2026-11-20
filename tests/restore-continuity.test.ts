import test from 'node:test'
import assert from 'node:assert/strict'
import { SequentialIdFactory, seedFromState } from '../src/kernel/util/ids.ts'
import { WorldBridge } from '../src/kernel/cycle/bridge.ts'
import { AutonomyRunner } from '../src/kernel/cycle/runner.ts'
import { RuleMind } from '../src/kernel/cycle/mind.ts'
import type { WorldService } from '../src/kernel/world/service.ts'
import { createRig, cleanupRigs } from './helpers.ts'

// M1 review (Codex, 2026-11-20): rebuilding a character from storage must not reuse ids, reset
// drives or lose the cumulative Situation.

test.after(() => cleanupRigs())

test('seedFromState continues above the highest id, not above a count', () => {
    const ids = new SequentialIdFactory()
    const memories = Array.from({ length: 130 }, (_, i) => ({ id: `mem_ep_${String(i + 1).padStart(3, '0')}` }))
    // A settled promise and a delivered message still own their ids.
    seedFromState(ids, { episodic: memories, runtime: { promises: [{ id: 'prom_004', status: 'kept' }], pendingMessages: [{ id: 'msg_002', status: 'delivered' }] } })
    assert.equal(ids.next('mem_ep'), 'mem_ep_131')
    assert.equal(ids.next('prom'), 'prom_005')
    assert.equal(ids.next('msg'), 'msg_003')
    assert.equal(ids.next('ms'), 'ms_001')
    // Only whole id strings count: "items_009" is not an "ms" id.
    const other = new SequentialIdFactory()
    seedFromState(other, { note: 'items_009', x: 'prom_7x' })
    assert.equal(other.next('ms'), 'ms_001')
    assert.equal(other.next('prom'), 'prom_001')
})

test('runner start keeps restored drives, including names that shadow Object.prototype', () => {
    const rig = createRig()
    const ws = rig.workspace
    const profile = {
        specs: [
            { name: 'constructor', label: '怪名字', risePerHour: 0.1, wakeThreshold: 0.9, initial: 0.1 },
            { name: 'hunger', label: '饥饿', risePerHour: 0.1, wakeThreshold: 0.9, initial: 0.3 },
        ],
        satisfiers: [],
    }
    ws.motivation.setDriveProfile(profile)
    const world = { list: () => [], observations: () => [], manifest: () => [], enabled: true } as unknown as WorldService
    const bridge = new WorldBridge({ agent: ws, world, instanceId: 'i', ids: new SequentialIdFactory() })
    const runner = () => new AutonomyRunner({
        agent: ws, world, worldId: 'w', instanceId: 'i', bridge, mind: new RuleMind({ remedies: {}, means: {}, routine: [], places: [], actFloor: 0.5 }),
        waker: { useDrives: true, heartbeatMs: 1, minGapMs: 1, driveRepeatMs: 1, maxWakesPerHour: 1 }, driveInputToMind: true, ids: new SequentialIdFactory(),
    })
    runner().start()
    assert.equal(ws.dynamicState.drives?.['constructor' as string]?.level, 0.1, 'an own-property check, not an inherited one')
    assert.equal(ws.dynamicState.drives?.hunger?.level, 0.3)
    const before = structuredClone(ws.dynamicState.drives)
    runner().start()
    assert.deepEqual(ws.dynamicState.drives, before, 'a second runner does not reset them')
})

test('bridge resume rebuilds a cumulative Situation from every observation up to the cursor', () => {
    const rig = createRig()
    const observations = [
        { seq: 1, eventId: 'e1', receivedAtSim: 10, summary: '在面包房', facts: [{ key: 'snapshot', value: true }, { key: 'location', value: 'bakery' }, { key: 'present', value: 'npc_lin' }] },
        { seq: 2, eventId: 'e2', receivedAtSim: 20, summary: '面包卖完了', facts: [{ key: 'event', value: 'stock_out:bread' }] },
    ]
    const world = {
        list: () => [],
        observations: (_: string, since = 0) => observations.filter((o) => o.seq > since),
    } as unknown as WorldService
    const n = rig.workspace.memory.list().length
    new WorldBridge({ agent: rig.workspace, world, instanceId: 'i', ids: new SequentialIdFactory(), resumeFrom: { seenActionIds: [], observationCursor: 2 } })
    const sit = rig.workspace.situation.current()
    assert.equal(sit.location, 'bakery', 'the location from the earlier snapshot survives the event-only observation')
    assert.deepEqual(sit.present, ['npc_lin'])
    assert.equal(rig.workspace.memory.list().length, n, 'resume writes no memory')
})
