import { it } from 'node:test'
import assert from 'node:assert/strict'
import { createRig, openSession } from './helpers.ts'

it('bounds checkpoints while keeping the newest state, including changes without new events', () => {
    const rig = createRig()
    try {
        const session = openSession(rig)
        session.saveSnapshot()
        const initial = rig.persistence.latestSnapshot(rig.instance.id)!.state
        for (let i = 0; i < 80; i++) {
            rig.persistence.saveSnapshot(rig.instance.id, {
                ...initial,
                savedAtWall: new Date(Date.UTC(2026, 0, 1) + i * 360000).toISOString(),
                savedAtSim: i,
                runtime: { marker: i },
            })
        }
        const count = rig.db.prepare('SELECT count(*) AS n FROM snapshots WHERE instance_id = ?').get(rig.instance.id) as { n: number }
        assert.ok(count.n <= 32, `unexpected retained checkpoints: ${count.n}`)
        assert.deepEqual(rig.persistence.latestSnapshot(rig.instance.id)!.state.runtime, { marker: 79 })
    } finally {
        rig.db.close()
    }
})

it('coalesces frequent saves but persists the latest recovery time and runtime', () => {
    const rig = createRig()
    try {
        const session = openSession(rig)
        session.saveSnapshot()
        const initial = rig.persistence.latestSnapshot(rig.instance.id)!.state
        rig.db.exec('DELETE FROM snapshots')
        const first = rig.persistence.saveSnapshot(rig.instance.id, initial)
        for (let i = 1; i <= 100; i++) {
            rig.persistence.saveSnapshot(rig.instance.id, {
                ...initial,
                savedAtWall: new Date(Date.parse(initial.savedAtWall) + i * 1000).toISOString(),
                savedAtSim: i,
                runtime: { marker: i },
            })
        }
        const latest = rig.persistence.latestSnapshot(rig.instance.id)!
        assert.equal(latest.id, first.id)
        assert.equal(latest.state.savedAtSim, 100)
        assert.deepEqual(latest.state.runtime, { marker: 100 })
        assert.equal((rig.db.prepare('SELECT count(*) AS n FROM snapshots').get() as { n: number }).n, 1)
    } finally {
        rig.db.close()
    }
})

it('starts a new checkpoint at the bucket boundary and rolls back failed pruning', () => {
    const rig = createRig()
    try {
        openSession(rig).saveSnapshot()
        const initial = rig.persistence.latestSnapshot(rig.instance.id)!.state
        rig.db.exec('DELETE FROM snapshots')
        const first = rig.persistence.saveSnapshot(rig.instance.id, {
            ...initial, savedAtWall: '2026-01-01T00:04:59.000Z',
        })
        const second = rig.persistence.saveSnapshot(rig.instance.id, {
            ...initial, savedAtWall: '2026-01-01T00:05:00.000Z',
        })
        assert.notEqual(second.id, first.id)
        for (let i = 2; i < 32; i++) {
            rig.persistence.saveSnapshot(rig.instance.id, {
                ...initial, savedAtWall: new Date(Date.UTC(2026, 0, 1) + i * 300000).toISOString(),
            })
        }
        const before = rig.persistence.latestSnapshot(rig.instance.id)
        rig.db.exec("CREATE TRIGGER reject_prune BEFORE DELETE ON snapshots BEGIN SELECT RAISE(ABORT, 'prune failed'); END")
        assert.throws(() => rig.persistence.saveSnapshot(rig.instance.id, {
            ...initial, savedAtWall: '2026-01-02T00:00:00.000Z', runtime: { marker: 'must roll back' },
        }), /prune failed/)
        assert.deepEqual(rig.persistence.latestSnapshot(rig.instance.id), before)
        assert.equal((rig.db.prepare('SELECT count(*) AS n FROM snapshots').get() as { n: number }).n, 32)
    } finally {
        rig.db.close()
    }
})
