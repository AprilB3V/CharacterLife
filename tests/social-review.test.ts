import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_SOCIAL_CONFIG, SocialCognition } from 'characterlife/social'
import type { SocialEvidence, SocialState, SocialStore } from 'characterlife/social'

// Codex review of the social module (2026-11-21): one regression per confirmed finding.

const MIN = 60 * 1000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

function memStore(initial: unknown = null): SocialStore & { saved: SocialState | null; raw: () => string } {
    const s = {
        saved: initial as SocialState | null,
        load: () => s.saved,
        save: (state: SocialState) => { s.saved = structuredClone(state) },
        raw: () => JSON.stringify(s.saved),
    }
    return s
}

const ev = (over: Partial<SocialEvidence>): SocialEvidence => ({
    about: 'u1', kind: 'emotion', claim: '有点烦躁', direction: 'support', strength: 'tone', ref: 'obs1', ...over,
})

/** A valid saved state whose first hypothesis is patched. */
function patched(over: Record<string, unknown>): unknown {
    const s = new SocialCognition()
    s.observe([ev({ kind: 'relation', claim: '是同学' })], 0)
    const state = s.snapshot() as unknown as { people: { u1: { hypotheses: Array<Record<string, unknown>> } } }
    Object.assign(state.people.u1.hypotheses[0]!, over)
    return state
}

test('a late prediction on a cleared sensitive guess reopens nothing and stores nothing', () => {
    const store = memStore()
    const s = new SocialCognition({ store })
    s.observe([ev({ kind: 'expectation', claim: '会提起最近的事', prediction: '会说起 depression' })], 0)
    const line = s.view('u1', 0).now[0]!
    assert.ok(line.sensitive)
    const ch = s.resolvePrediction(line.id, true, 'r', 3 * HOUR)
    assert.ok(ch.every((c) => c.kind !== 'opened'))
    assert.ok(!store.raw().includes('会提起最近的事') && !store.raw().includes('depression'))
})

test('sensitivity flagged later in the same call redacts earlier records and purges stored traces', () => {
    const store = memStore()
    const s = new SocialCognition({ store })
    const ch = s.observe([ev({ claim: '心情不好' }), ev({ claim: '心情不好', sensitive: true, ref: 'o2' })], 0)
    assert.ok(ch.every((c) => !c.detail.includes('心情不好')), JSON.stringify(ch))
    // Across a gap: the closed normal record with that claim is purged once it is flagged
    s.observe([ev({ claim: '在为考试发愁' })], 10 * MIN)
    s.observe([ev({ claim: '在为考试发愁', sensitive: true, ref: 'o3' })], 4 * HOUR)
    assert.ok(!store.raw().includes('考试'))
})

test('a cue behind a sensitive claim is removed; rejection records never carry proposal text', () => {
    const store = memStore()
    const s = new SocialCognition({ store })
    const [p] = s.proposeCue({ about: 'u1', cue: '叹气', implies: { kind: 'emotion', claim: '压力很大' }, sourceRef: 'o' }, 0)
    s.observe([ev({ claim: '压力很大', cueRuleId: p!.id, sensitive: true })], 0)
    assert.ok(!store.raw().includes('压力很大') && !store.raw().includes('叹气'))
    const [r] = s.proposeCue({ about: '*', cue: 'depression', implies: { kind: 'emotion', claim: 'x' }, sourceRef: 'o' }, 0)
    assert.ok(!r!.detail.includes('depression'))
    const [r2] = s.proposeCue({ about: '*', cue: '嗯', implies: { kind: 'emotion', claim: '敷衍' }, sourceRef: 'o' }, 0)
    assert.ok(!r2!.detail.includes('敷衍'))
})

test('the lexicon sees text past the truncation point and re-checks on load', () => {
    const store = memStore()
    const s = new SocialCognition({ store })
    s.observe([ev({ kind: 'relation', claim: `${'很'.repeat(90)}depression` })], 0)
    assert.equal(store.saved!.people.u1!.hypotheses.length, 0)
    const loaded = new SocialCognition({ store: memStore(patched({ claim: 'depression' })) })
    assert.equal(loaded.snapshot().people.u1!.hypotheses.length, 0)
})

test('ids continue past the highest loaded id, so feedback never lands on another person', () => {
    const a = new SocialCognition()
    a.observe([ev({ about: 'alice', kind: 'expectation', claim: '会回来', prediction: '明天上线' })], 0)
    const state = a.snapshot()
    state.seq = 0
    const s = new SocialCognition({ store: memStore(state) })
    s.beginSession('bob', 'b', 0)
    s.observe([ev({ about: 'bob', kind: 'expectation', claim: '要走了', prediction: '马上下线' })], 0)
    const bobId = s.view('bob', 0).now[0]!.id
    assert.notEqual(bobId, a.view('alice', 0).now[0]!.id)
    s.resolvePrediction(bobId, true, 'r', MIN)
    assert.equal(s.view('bob', MIN).now[0]!.prediction, null)
    assert.equal(s.view('alice', MIN).now[0]!.prediction, '明天上线')
})

test('hostile JSON never throws; short-term kinds cannot load as confirmed', () => {
    assert.doesNotThrow(() => new SocialCognition({ store: memStore(patched({ kind: { toString: null } })) }))
    const s = new SocialCognition({ store: memStore(patched({ kind: 'expectation', status: 'confirmed' })) })
    assert.equal(s.snapshot().people.u1!.hypotheses.length, 0)
})

test('a prediction scores only the cues behind it', () => {
    const s = new SocialCognition()
    const [a] = s.proposeCue({ about: 'u1', cue: 'A', implies: { kind: 'expectation', claim: '会走' }, sourceRef: 'o' }, 0)
    const [b] = s.proposeCue({ about: 'u1', cue: 'B', implies: { kind: 'expectation', claim: '会走' }, sourceRef: 'o' }, 0)
    s.observe([ev({ kind: 'expectation', claim: '会走', prediction: 'p1', cueRuleId: a!.id, ref: 'e1' })], 0)
    let id = s.view('u1', 0).now[0]!.id
    s.resolvePrediction(id, true, 'r1', 1)
    s.observe([ev({ kind: 'expectation', claim: '会走', prediction: 'p2', cueRuleId: b!.id, ref: 'e2' })], 2)
    id = s.view('u1', 2).now[0]!.id
    s.resolvePrediction(id, true, 'r2', 3)
    const cues = s.snapshot().people.u1!.cues
    assert.equal(cues.find((c) => c.id === a!.id)!.hits, 1)
    assert.equal(cues.find((c) => c.id === b!.id)!.hits, 1)
})

test('reads respect the session gap; a reused host session id after a gap is a new session', () => {
    const s = new SocialCognition()
    s.observe([ev({ kind: 'preference', claim: '偏好 depression 话题' })], 0)
    assert.equal(s.view('u1', 3 * HOUR).now.length, 0, 'sensitive guess hidden after the gap without sweep')
    for (let i = 0; i < 3; i++) {
        s.beginSession('u1', 'same-host-id', i * 3 * HOUR)
        s.observe([ev({ kind: 'preference', claim: '喜欢短句', strength: 'behavior', ref: `p${i}` })], i * 3 * HOUR)
    }
    assert.equal(s.promotable('u1', 6 * HOUR).length, 1)
})

test('repeated evidence does not inflate; decayed guesses are not promotable', () => {
    const s = new SocialCognition()
    for (let i = 0; i < 5; i++) s.observe([ev({ ref: 'same' })], 0)
    assert.equal(s.view('u1', 0).now[0]!.confidence, 0.2)
    for (const [i, sid] of ['a', 'b', 'c'].entries()) {
        s.beginSession('u1', sid, i * DAY)
        s.observe([ev({ kind: 'preference', claim: '喜欢猫', strength: 'behavior', ref: `c${i}` })], i * DAY)
    }
    assert.equal(s.promotable('u1', 2 * DAY).length, 1)
    assert.equal(s.promotable('u1', 500 * DAY).length, 0)
})

test('reset() is the running rollback; configs are not shared; caps behave at the edges', () => {
    const store = memStore()
    const s = new SocialCognition({ store })
    s.observe([ev({ kind: 'relation', claim: '是同事' })], 0)
    s.reset()
    s.beginSession('bob', 'b', MIN)
    assert.ok(!store.raw().includes('同事'))

    const x = new SocialCognition()
    x.config.strengthWeight.tone = 0.7
    assert.equal(new SocialCognition().config.strengthWeight.tone, 0.2)
    assert.equal(DEFAULT_SOCIAL_CONFIG.strengthWeight.tone, 0.2)

    const zero = new SocialCognition({ config: { maxShortTermOpen: 0 } })
    assert.doesNotThrow(() => zero.observe([ev({})], 0))
    assert.equal(zero.view('u1', 0).now.length, 0)
    const one = new SocialCognition({ config: { maxLongTermOpen: 1 } })
    one.observe([ev({ kind: 'preference', claim: '喜欢雨天', strength: 'behavior' })], 0)
    one.observe([ev({ kind: 'preference', claim: '讨厌早起', strength: 'stated' })], 0)
    assert.equal(one.view('u1', 0).model.length, 2, 'a confirmed fact does not evict an open guess')
})

test('view() has no side effects and honours a zero proposed-cue limit', () => {
    const s = new SocialCognition()
    s.proposeCue({ about: 'u1', cue: '嗯', implies: { kind: 'intent', claim: '想结束' }, sourceRef: 'o' }, 0)
    const before = JSON.stringify(s.snapshot())
    assert.equal(s.view('u1', 0, { proposedCues: 0 }).cues.length, 0)
    assert.equal(JSON.stringify(s.snapshot()), before)
})
