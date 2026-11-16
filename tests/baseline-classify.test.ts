import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    classifyAttempt,
    classifyCall,
    needsResend,
    replyLeaksMarkup,
    summarize,
} from '../experiments/real-model/baseline-classify.ts'
import type { AttemptRecord, CallObservation } from '../experiments/real-model/baseline-classify.ts'
import { BASELINE_SCRIPT } from '../experiments/real-model/baseline-script.ts'

const call = (over: Partial<CallObservation> = {}): CallObservation => ({
    ok: true,
    text: '{"reply":"嗯，我在。"}',
    finishReason: 'stop',
    error: null,
    promptTokens: 100,
    completionTokens: 10,
    latencyMs: 50,
    reasoningChars: 0,
    ...over,
})

const MEMORY_ENVELOPE = JSON.stringify({
    reply: '栗子，记住了。',
    memoryWrites: [{ kind: 'user', title: '猫', content: '用户养了一只叫栗子的橘猫', status: 'fact' }],
})
const plainLine = BASELINE_SCRIPT.find((l) => l.n === 1)!
const factLine = BASELINE_SCRIPT.find((l) => l.n === 11)!
const probeLine = BASELINE_SCRIPT.find((l) => l.n === 32)!
const mangoLine = BASELINE_SCRIPT.find((l) => l.n === 34)!

const attempt = (line: typeof plainLine, calls: CallObservation[], reply: string, extra: Partial<AttemptRecord> = {}): AttemptRecord => ({
    session: 1,
    line: line.n,
    attempt: 1,
    reply,
    degradation: 'none',
    calls,
    ...classifyAttempt({ line, reply, degradation: extra.degradation ?? 'none', calls }),
    ...extra,
})

test('script has 60 consecutive lines', () => {
    assert.deepEqual(BASELINE_SCRIPT.map((l) => l.n), Array.from({ length: 60 }, (_, i) => i + 1))
})

test('classifyCall maps each raw outcome to its code', () => {
    assert.equal(classifyCall(call()).code, null)
    assert.equal(classifyCall(call({ ok: false, text: '', error: 'HTTP 500' })).code, 'F1')
    assert.equal(classifyCall(call({ text: '   \n ' })).code, 'F2')
    assert.equal(classifyCall(call({ text: '{"type":"json_object"}' })).code, 'F3')
    assert.equal(classifyCall(call({ text: '嗯，我在。' })).code, 'F4')
    assert.equal(classifyCall(call({ text: '{“reply”：“全角引号”}' })).code, 'F4')
    assert.equal(classifyCall(call({ text: '{"reply":"被截', finishReason: 'length' })).code, 'F6g')
    assert.equal(classifyCall(call({ text: '', finishReason: 'length' })).code, 'F6g')
})

test('classifyCall counts memory writes and reports unknown keys', () => {
    const verdict = classifyCall(call({ text: MEMORY_ENVELOPE }))
    assert.equal(verdict.memoryWrites, 1)
    assert.deepEqual(classifyCall(call({ text: '{"reply":"好","好感度":10}' })).unknownKeys, ['好感度'])
})

test('fact-planting turn without a memory write is F6a', () => {
    assert.deepEqual(classifyAttempt({ line: factLine, reply: '好。', degradation: 'none', calls: [call()] }).codes, ['F6a'])
    assert.deepEqual(
        classifyAttempt({ line: factLine, reply: '栗子，记住了。', degradation: 'none', calls: [call({ text: MEMORY_ENVELOPE })] }).codes,
        [],
    )
    assert.deepEqual(classifyAttempt({ line: plainLine, reply: '好。', degradation: 'none', calls: [call()] }).codes, [])
})

test('markup inside the reply is F6b and triggers a re-send', () => {
    assert.equal(replyLeaksMarkup('当然可以：```python\nprint(1)'), true)
    assert.equal(replyLeaksMarkup('{"reply": "漏出来了"}'), true)
    assert.equal(replyLeaksMarkup('<thinking>她在试探我</thinking>嗯。'), true)
    assert.equal(replyLeaksMarkup('今天风有点大（笑）。'), false)
    const leaked = attempt(plainLine, [call()], '好的 ```json')
    assert.deepEqual(leaked.codes, ['F6b'])
    assert.equal(needsResend(leaked), true)
})

test('context exceeded without a call is F5', () => {
    const record = attempt(plainLine, [], '', { degradation: 'exceeded' })
    assert.deepEqual(record.codes, ['F5'])
    assert.equal(needsResend(record), true)
})

test('a kernel retry that succeeds keeps F3 on record but needs no re-send', () => {
    const record = attempt(plainLine, [call({ text: '{"type":"json_object"}' }), call()], '嗯，我在。')
    assert.deepEqual(record.codes, ['F3'])
    assert.equal(needsResend(record), false)
})

test('probes: expected word must appear, forbidden word must not', () => {
    assert.equal(attempt(probeLine, [call()], '叫栗子呀。').probeHit, true)
    assert.equal(attempt(probeLine, [call()], '我不太记得了。').probeHit, false)
    assert.equal(attempt(mangoLine, [call()], '芒果班戟不错。').probeHit, false)
    assert.equal(attempt(mangoLine, [call()], '双皮奶吧。').probeHit, true)
    assert.equal(attempt(plainLine, [call()], '在。').probeHit, null)
})

test('summarize: resend rate, state loss and per-code rates', () => {
    const attempts: AttemptRecord[] = [
        // Line 1: clean.
        attempt(plainLine, [call()], '在。'),
        // Line 2: blank, then a clean re-send.
        attempt(BASELINE_SCRIPT[1]!, [call({ text: ' ' })], '降级台词'),
        attempt(BASELINE_SCRIPT[1]!, [call()], '还行。', { attempt: 2 }),
        // Line 3: plain text instead of JSON, shown as-is, state lost.
        attempt(BASELINE_SCRIPT[2]!, [call({ text: '辛苦了。' })], '辛苦了。'),
        // Line 4: kernel retried once and recovered.
        attempt(BASELINE_SCRIPT[3]!, [call({ text: '{"a":1}' }), call()], '在看书。'),
    ]
    const summary = summarize(attempts)
    assert.equal(summary.turns, 4)
    assert.equal(summary.calls, 6)
    assert.equal(summary.validReplies, 4)
    assert.equal(summary.resendRate, 1.5)
    assert.equal(summary.invalidOutputRate, 0.75)
    assert.equal(summary.firstAttemptRate.F2, 0.25)
    assert.equal(summary.firstAttemptRate.F3, 0.25)
    assert.equal(summary.firstAttemptRate.F4, 0.25)
    assert.equal(summary.stateLossRate, 0.25)
    assert.equal(summary.tokensPerValidReply, (6 * 110) / 4)
    assert.equal(summary.replyLengthRatio, null)
})
