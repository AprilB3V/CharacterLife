import assert from 'node:assert/strict'
import test from 'node:test'
import * as root from 'characterlife'
import * as kernel from 'characterlife/kernel'
import * as runtime from 'characterlife/runtime'
import * as api from 'characterlife/api'
import * as consoleEntry from 'characterlife/console'

test('package exports resolve every public entry by name', () => {
    assert.equal(typeof root.CharacterWorkspace, 'function')
    assert.equal(typeof root.SqliteLedgerSink, 'function')
    assert.equal(typeof kernel.MotivationSlot, 'function')
    assert.equal(typeof runtime.InstanceRuntimeManager, 'function')
    assert.equal(typeof api.assembleRuntime, 'function')
    assert.equal(typeof consoleEntry.createConsoleServer, 'function')
})

test('commitment criterion keeps only kind and opaque params; legacy flat shape is folded in', () => {
    const slot = new kernel.MotivationSlot({ dynamic: () => ({}) as never, now: () => 0 })
    slot.fromJSON([{ id: 'c1', text: 'legacy', madeAtSim: 0, dueAtSim: 1, status: 'open',
        criterion: { kind: 'avoid_purchase', worldId: 'w', runId: 'r', readerSeq: 3 } as never }])
    assert.deepEqual(slot.get('c1')?.criterion, { kind: 'avoid_purchase', params: { worldId: 'w', runId: 'r', readerSeq: 3 } })
    assert.ok(slot.updateCriterion('c1', { kind: 'avoid_purchase', params: { worldId: 'w', runId: 'r', readerSeq: 4 } }))
    assert.equal(slot.get('c1')?.criterion?.params.readerSeq, 4)
    slot.add({ id: 'c2', text: 'new', madeAtSim: 0, dueAtSim: 1, status: 'open', criterion: { kind: 'custom', params: { x: 1 } } })
    assert.deepEqual(slot.get('c2')?.criterion, { kind: 'custom', params: { x: 1 } })
})
