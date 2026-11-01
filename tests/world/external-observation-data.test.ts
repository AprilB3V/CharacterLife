import test from 'node:test'
import assert from 'node:assert/strict'
import { buildExternalObservationData } from '../../src/kernel/world/external-observations.ts'
import type { WorldObservationRecord } from '../../src/kernel/world/contracts.ts'

function record(eventId: string, snapshotId: string, page: number, pages: number): WorldObservationRecord {
    return { seq: 1, eventId, worldId: 'world', instanceId: 'instance', atWorldTimeMs: 100,
        receivedAtSim: 100, summary: 'inventory', facts: [{ key: 'snapshotId', value: snapshotId },
            { key: 'page', value: page }, { key: 'pages', value: pages }, { key: 'cash', value: 8765 }] }
}

test('expired and incomplete snapshots cannot present old balances as current facts', () => {
    const old = record('old', 'old', 0, 1)
    const incomplete = record('new', 'new', 0, 2)
    assert.ok(!buildExternalObservationData([old, incomplete], 100).includes('8765'))
    assert.ok(!buildExternalObservationData([old], 15101).includes('8765'))
    const complete = record('new-2', 'new', 1, 2)
    const data = buildExternalObservationData([old, incomplete, complete], 100)
    assert.match(data, /8765/)
    assert.ok(!data.includes('"old"'))
})
