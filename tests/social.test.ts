import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import * as kernel from 'characterlife/kernel'
import {
    DEFAULT_SOCIAL_CONFIG, DisabledSocialCognition, SOCIAL_STATE_VERSION, SocialCognition,
    againstUpdate, createSocialCognition, evidenceWeight, sensitiveCategories, supportUpdate,
} from 'characterlife/social'
import type { CueRule, SocialEvidence, SocialState, SocialStore } from 'characterlife/social'

// Social cognition (theory of mind) T0, 2026-11-21: pure arithmetic + pluggable module.

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

test('confidence arithmetic is bounded and monotone', () => {
    assert.equal(supportUpdate(0, 0.6), 0.6)
    assert.ok(Math.abs(supportUpdate(0.6, 0.6) - 0.84) < 1e-9)
    assert.ok(Math.abs(againstUpdate(0.84, 0.6) - 0.336) < 1e-9)
    assert.equal(supportUpdate(1, 0.8), 1)
    const cfg = DEFAULT_SOCIAL_CONFIG
    assert.ok(evidenceWeight('stated', null, cfg) > evidenceWeight('behavior', null, cfg))
    assert.ok(evidenceWeight('behavior', null, cfg) > evidenceWeight('tone', null, cfg))
    const proposed = { status: 'proposed', weight: 1 } as CueRule
    const active = { status: 'active', weight: 1 } as CueRule
    assert.equal(evidenceWeight('tone', proposed, cfg), evidenceWeight('tone', null, cfg), 'proposed cue has no effect')
    assert.ok(evidenceWeight('tone', active, cfg) > evidenceWeight('tone', null, cfg))
    assert.ok(evidenceWeight('stated', active, cfg) <= cfg.maxWeight)
})

test('support opens and strengthens; inferred counter-evidence refutes below the floor', () => {
    const s = new SocialCognition()
    let ch = s.observe([ev({})], 0)
    assert.equal(ch.find((c) => c.kind === 'opened')?.semantic, 'situation')
    s.observe([ev({ claim: '有点烦躁！', strength: 'behavior', ref: 'obs2' })], MIN)
    const line = s.view('u1', MIN).now[0]!
    assert.equal(s.view('u1', MIN).now.length, 1, 'same claim merges after normalization')
    assert.ok(line.confidence > 0.4)
    for (let i = 0; i < 5; i++) ch = s.observe([ev({ direction: 'against', strength: 'behavior', ref: `x${i}` })], 2 * MIN)
    assert.ok(s.view('u1', 2 * MIN).now.length === 0)
    assert.ok(s.snapshot().people.u1!.hypotheses.some((h) => h.status === 'refuted' && h.against.length > 0), 'refuted keeps its evidence')
})

test('counter-evidence alone never opens a hypothesis', () => {
    const s = new SocialCognition()
    assert.deepEqual(s.observe([ev({ direction: 'against' })], 0), [])
    assert.equal(s.snapshot().people.u1?.hypotheses.length ?? 0, 0)
})

test('short-term guesses decay and expire; confirmed long-term facts do not', () => {
    const s = new SocialCognition()
    s.observe([ev({ strength: 'behavior' })], 0)
    s.observe([ev({ kind: 'preference', claim: '喜欢直接给结论', strength: 'stated' })], 0)
    assert.equal(s.view('u1', 0).model[0]!.status, 'confirmed')
    // 90 min is inside the session gap: decay alone (20 min half-life) expires the emotion
    const ch = s.sweep(90 * MIN)
    assert.ok(ch.some((c) => c.kind === 'expired' && c.detail.startsWith('emotion')))
    // long after, the preference stays at full confidence
    const later = s.view('u1', 90 * DAY)
    assert.equal(later.now.length, 0)
    assert.equal(later.model[0]!.claim, '喜欢直接给结论')
    assert.equal(later.model[0]!.confidence, s.snapshot().people.u1!.hypotheses.find((h) => h.kind === 'preference')!.confidence)
})

test('a confirmed fact resists inference and falls only to a stated denial', () => {
    const s = new SocialCognition()
    s.observe([ev({ kind: 'preference', claim: '不喜欢被追问', strength: 'stated' })], 0)
    s.observe([ev({ kind: 'preference', claim: '不喜欢被追问', direction: 'against', strength: 'behavior', ref: 'b1' })], MIN)
    assert.equal(s.view('u1', MIN).model[0]!.status, 'confirmed')
    s.observe([ev({ kind: 'preference', claim: '不喜欢被追问', direction: 'against', strength: 'stated', ref: 's1' })], 2 * MIN)
    assert.equal(s.view('u1', 2 * MIN).model.length, 0)
    assert.equal(s.snapshot().people.u1!.hypotheses[0]!.status, 'refuted')
})

test('a new session clears short-term state but keeps the long-term model', () => {
    const s = new SocialCognition()
    s.beginSession('u1', 'a', 0)
    s.observe([ev({}), ev({ kind: 'relation', claim: '一起玩过 Probably Stolen', strength: 'behavior' })], 0)
    const ch = s.beginSession('u1', 'b', 10 * MIN)
    assert.ok(ch.some((c) => c.kind === 'cleared'))
    const v = s.view('u1', 10 * MIN)
    assert.equal(v.now.length, 0)
    assert.equal(v.model.length, 1)
    // A long silence without beginSession also ends the session
    s.observe([ev({ claim: '很开心' })], 11 * MIN)
    s.observe([ev({ kind: 'intent', claim: '想聊游戏' })], 11 * MIN + 3 * HOUR)
    assert.deepEqual(s.view('u1', 11 * MIN + 3 * HOUR).now.map((l) => l.claim), ['想聊游戏'])
})

test('group chat: hypotheses are keyed by person and never cross', () => {
    const s = new SocialCognition()
    s.observe([ev({ about: 'qq:1', claim: '在开玩笑' }), ev({ about: 'qq:2', claim: '有点生气' })], 0)
    assert.deepEqual(s.view('qq:1', 0).now.map((l) => l.claim), ['在开玩笑'])
    assert.deepEqual(s.view('qq:2', 0).now.map((l) => l.claim), ['有点生气'])
    s.endSession('qq:1', MIN)
    assert.equal(s.view('qq:1', MIN).now.length, 0)
    assert.equal(s.view('qq:2', MIN).now.length, 1)
})

test('sensitive guesses never reach storage, are redacted in audit and die with the session', () => {
    assert.deepEqual(sensitiveCategories('最近好像在吃抗抑郁的药'), ['health'])
    const store = memStore()
    const s = new SocialCognition({ store })
    const ch = s.observe([
        ev({ claim: '可能最近抑郁了', strength: 'behavior' }),
        ev({ kind: 'preference', claim: '应该信佛教', strength: 'stated' }),
        ev({ claim: '有点累', sensitive: true }),
    ], 0)
    for (const c of ch) {
        assert.equal(c.sensitive, true)
        assert.ok(!c.detail.includes('抑郁') && !c.detail.includes('佛教') && !c.detail.includes('有点累'), c.detail)
        assert.match(c.detail, /sha256:/)
    }
    assert.ok(!store.raw().includes('抑郁') && !store.raw().includes('佛教') && !store.raw().includes('有点累'))
    const v = s.view('u1', 0)
    assert.equal(v.now.length, 3, 'visible to the renderer for tone, in the short-term list')
    assert.ok(v.now.every((l) => l.sensitive))
    assert.ok(v.model.length === 0, 'a sensitive preference is never long-term, never confirmed')
    assert.ok(v.now.every((l) => l.status === 'open'))
    s.endSession('u1', MIN)
    assert.equal(s.view('u1', MIN).now.length, 0)
})

test('a stored guess that turns sensitive is moved out of storage', () => {
    const store = memStore()
    const s = new SocialCognition({ store })
    s.observe([ev({ kind: 'relation', claim: '最近和家里人有矛盾', strength: 'behavior' })], 0)
    assert.ok(store.raw().includes('家里人有矛盾'))
    s.observe([ev({ kind: 'relation', claim: '最近和家里人有矛盾', strength: 'behavior', sensitive: true })], MIN)
    assert.ok(!store.raw().includes('家里人有矛盾'))
    assert.equal(s.view('u1', MIN).now[0]!.sensitive, true)
})

test('cue rules: proposed -> active after hits; retired after misses; sensitive and global ones rejected', () => {
    const s = new SocialCognition()
    const [p] = s.proposeCue({ about: 'u1', cue: '嗯。', implies: { kind: 'intent', claim: '不想继续这个话题' }, sourceRef: 'o1' }, 0)
    assert.equal(p!.kind, 'cue_proposed')
    assert.deepEqual(s.proposeCue({ about: 'u1', cue: '嗯。', implies: { kind: 'intent', claim: '不想继续这个话题！' }, sourceRef: 'o2' }, 0), [], 'duplicate merges')
    assert.deepEqual(s.snapshot().people.u1!.cues[0]!.sourceRefs, ['o1', 'o2'])
    assert.equal(s.proposeCue({ about: '*', cue: 'x', implies: { kind: 'intent', claim: 'y' }, sourceRef: 'o' }, 0)[0]!.kind, 'cue_rejected')
    const sens = s.proposeCue({ about: 'u1', cue: '提到医院', implies: { kind: 'emotion', claim: '身体不好' }, sourceRef: 'o' }, 0)[0]!
    assert.equal(sens.kind, 'cue_rejected')
    assert.ok(sens.sensitive && !sens.detail.includes('医院'))

    const ruleId = p!.id
    let activated = false
    for (let i = 0; i < 3; i++) {
        s.observe([ev({ kind: 'expectation', claim: '会换话题', prediction: '下一句换话题', cueRuleId: ruleId, ref: `c${i}` })], i * MIN)
        const h = s.view('u1', i * MIN).now.find((l) => l.kind === 'expectation')!
        const ch = s.resolvePrediction(h.id, true, `r${i}`, i * MIN + 1)
        activated ||= ch.some((c) => c.kind === 'cue_activated')
    }
    assert.ok(activated)
    assert.equal(s.view('u1', 4 * MIN).cues[0]!.status, 'active')

    const [p2] = s.proposeCue({ about: 'u1', cue: '哈哈哈', implies: { kind: 'emotion', claim: '其实很尴尬' }, sourceRef: 'o3' }, 0)
    let retired = false
    for (let i = 0; i < 6; i++) {
        const claim = `尴尬${i}`
        s.observe([ev({ claim, cueRuleId: p2!.id, ref: `h${i}` })], 5 * MIN)
        const ch = s.observe([ev({ claim, direction: 'against', strength: 'stated', ref: `d${i}` })], 5 * MIN)
        retired ||= ch.some((c) => c.kind === 'cue_retired')
    }
    assert.ok(retired, 'stated denials blame the cue that suggested the guess')
})

test('prediction feedback only applies to open expectations, once', () => {
    const s = new SocialCognition()
    s.observe([ev({ kind: 'expectation', claim: '想听建议', prediction: '会追问怎么办' })], 0)
    const id = s.view('u1', 0).now[0]!.id
    assert.ok(s.resolvePrediction(id, false, 'r1', MIN).length > 0)
    assert.deepEqual(s.resolvePrediction(id, true, 'r2', MIN), [], 'prediction already consumed')
    s.observe([ev({ claim: '开心' })], MIN)
    const emo = s.view('u1', MIN).now.find((l) => l.kind === 'emotion')!.id
    assert.deepEqual(s.resolvePrediction(emo, true, 'r3', MIN), [])
})

test('promotable: long-term, normal, uncontradicted, supported in several sessions', () => {
    const s = new SocialCognition()
    for (const [i, sid] of ['a', 'b', 'c'].entries()) {
        s.beginSession('u1', sid, i * DAY)
        s.observe([ev({ kind: 'preference', claim: '晚上更愿意聊天', strength: 'behavior', ref: `p${i}` })], i * DAY)
        if (i < 2) assert.equal(s.promotable('u1', i * DAY).length, 0)
    }
    assert.equal(s.promotable('u1', 2 * DAY)[0]!.claim, '晚上更愿意聊天')
})

test('pluggable: disabled port has the same surface and no effect', () => {
    const off = createSocialCognition({ enabled: false })
    assert.ok(off instanceof DisabledSocialCognition)
    assert.equal(off.enabled, false)
    const store = memStore()
    const offWithStore = createSocialCognition({ enabled: false, store })
    offWithStore.beginSession('u1', 'a', 0)
    assert.deepEqual(offWithStore.observe([ev({})], 0), [])
    assert.deepEqual(offWithStore.proposeCue({ about: 'u1', cue: 'x', implies: { kind: 'intent', claim: 'y' }, sourceRef: 'o' }, 0), [])
    assert.deepEqual(offWithStore.view('u1', 0), { about: 'u1', now: [], model: [], cues: [] })
    assert.equal(store.saved, null, 'disabled module never writes')
    // Every method of the real module exists on the disabled one
    const on = createSocialCognition({ enabled: true })
    for (const k of Object.getOwnPropertyNames(Object.getPrototypeOf(on))) {
        if (k !== 'constructor') assert.equal(typeof (off as unknown as Record<string, unknown>)[k], 'function', k)
    }
})

test('rollback: state round-trips; unknown versions and forget() start clean', () => {
    const store = memStore()
    const a = new SocialCognition({ store })
    a.observe([ev({ kind: 'relation', claim: '是游戏搭子', strength: 'behavior' })], 0)
    const b = new SocialCognition({ store })
    assert.equal(b.view('u1', MIN).model[0]!.claim, '是游戏搭子')
    assert.equal(b.snapshot().seq, a.snapshot().seq)

    const future = new SocialCognition({ store: memStore({ version: SOCIAL_STATE_VERSION + 1, seq: 9, people: { u1: {} } }) })
    assert.deepEqual(future.people(), [])
    const sneaky = { version: SOCIAL_STATE_VERSION, seq: 1, people: { u1: { hypotheses: [{ id: 'h', kind: 'emotion', confidence: 1, sensitivity: 'sensitive' }], cues: [] } } }
    assert.equal(new SocialCognition({ store: memStore(sneaky) }).snapshot().people.u1!.hypotheses.length, 0)

    b.forget('u1')
    assert.deepEqual(b.people(), [])
    assert.ok(!store.raw().includes('游戏搭子'))
})

test('kernel surface is unchanged and the module imports only kernel utilities', () => {
    assert.equal((kernel as Record<string, unknown>).SocialCognition, undefined)
    const dir = join(process.cwd(), 'src', 'kernel', 'social')
    for (const f of readdirSync(dir)) {
        const src = readFileSync(join(dir, f), 'utf8')
        for (const m of src.matchAll(/from '([^']+)'/g)) {
            const spec = m[1]!
            assert.ok(spec.startsWith('./') || spec.startsWith('node:') || /^\.\.\/(util|semantics)\//.test(spec), `${f}: ${spec}`)
        }
    }
})

test('regression: a missed prediction scores its cue once, even when it refutes the guess', () => {
    const s = new SocialCognition({ config: { strengthWeight: { stated: 0.6, behavior: 0.9, tone: 0.2 }, maxWeight: 0.9 } })
    const [p] = s.proposeCue({ about: 'u1', cue: '嗯。', implies: { kind: 'expectation', claim: '会结束对话' }, sourceRef: 'o' }, 0)
    s.observe([ev({ kind: 'expectation', claim: '会结束对话', prediction: '马上下线', cueRuleId: p!.id })], 0)
    const id = s.view('u1', 0).now[0]!.id
    const ch = s.resolvePrediction(id, false, 'r', MIN)
    assert.ok(ch.some((c) => c.kind === 'refuted'))
    assert.equal(ch.filter((c) => c.kind === 'cue_scored').length, 1)
    assert.equal(s.snapshot().people.u1!.cues[0]!.misses, 1)
})

test('regression: an id pointing at a closed guess falls back to the open one with the same claim', () => {
    const s = new SocialCognition()
    s.observe([ev({ claim: '在生气' })], 0)
    const old = s.view('u1', 0).now[0]!.id
    s.observe([ev({ claim: '在生气', direction: 'against', strength: 'stated' })], MIN)
    s.observe([ev({ claim: '在生气' })], 2 * MIN)
    const open = s.view('u1', 2 * MIN).now[0]!.id
    s.observe([ev({ claim: '在生气', hypothesisId: old })], 3 * MIN)
    const live = s.snapshot().people.u1!.hypotheses.filter((h) => h.status === 'open')
    assert.equal(live.length, 1)
    assert.equal(live[0]!.id, open)
})

test('regression: loaded records must belong to their person; prototype keys are refused', () => {
    const good = new SocialCognition()
    good.observe([ev({ about: 'a', claim: '想聊天' })], 0)
    const state = good.snapshot()
    state.people.b = structuredClone(state.people.a!)
    state.people.b.about = 'b'
    const swapped = new SocialCognition({ store: memStore(state) })
    assert.equal(swapped.view('b', 0).now.length, 0, 'records still saying about=a are dropped under b')
    assert.equal(swapped.view('a', 0).now.length, 1)

    const broken = structuredClone(good.snapshot()) as unknown as { people: { a: { hypotheses: Array<Record<string, unknown>> } } }
    delete broken.people.a.hypotheses[0]!.support
    const loaded = new SocialCognition({ store: memStore(broken) })
    assert.doesNotThrow(() => loaded.observe([ev({ about: 'a', claim: '想聊天' })], MIN))

    const s = new SocialCognition()
    assert.deepEqual(s.observe([ev({ about: '__proto__' })], 0), [])
    assert.deepEqual(s.beginSession('constructor', 'x', 0), [])
    assert.equal(s.proposeCue({ about: '__proto__', cue: 'x', implies: { kind: 'intent', claim: 'y' }, sourceRef: 'o' }, 0)[0]!.kind, 'cue_rejected')
    assert.deepEqual(s.people(), [])
    assert.equal(({} as Record<string, unknown>).hypotheses, undefined, 'Object.prototype untouched')
})
