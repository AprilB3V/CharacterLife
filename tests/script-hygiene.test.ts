import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { BASELINE_SCRIPT } from '../experiments/real-model/baseline-script.ts'
import { MEMORY_SCRIPT } from '../experiments/real-model/memory-script.ts'
import { CURVE_SCRIPT } from '../experiments/real-model/curve-script.ts'

// M0 run 4 (2026-11-18): the cue example "猫、栗子、宠物" matched a planted fact and polluted recall.
test('protocol example words never appear in a test script', () => {
    const source = readFileSync(new URL('../src/conversation/context.ts', import.meta.url), 'utf8')
    const examples = [...source.matchAll(/例如 ([^"\]]+)/g)]
        .flatMap((m) => m[1]!.split(/[、\s]+/))
        .filter((w) => /^[一-鿿]+$/.test(w))
    assert.ok(examples.length > 0, 'found the example words')
    const text = [...BASELINE_SCRIPT, ...MEMORY_SCRIPT, ...CURVE_SCRIPT].map((l) => l.text).join('\n')
    assert.deepEqual(examples.filter((w) => text.includes(w)), [])
})

test('memory script lines are numbered 1..n and every probe has a check', () => {
    assert.deepEqual(MEMORY_SCRIPT.map((l) => l.n), Array.from({ length: MEMORY_SCRIPT.length }, (_, i) => i + 1))
    const probes = MEMORY_SCRIPT.filter((l) => l.probe)
    assert.equal(probes.length, 6)
    assert.ok(probes.every((l) => (l.probe!.expectAny?.length ?? 0) + (l.probe!.forbid?.length ?? 0) > 0))
})
