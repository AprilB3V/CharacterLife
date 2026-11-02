/**
 * Thinking loop: strict JSON thinker, continue-thinking with a queue, decision rules, willingness.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_VOCABULARY, LlmThinker, ThinkingLoop, Willingness, buildThinkerPrompt, decideThought, parseThought,
} from '../../src/kernel/thinking/index.ts'
import type { ThinkInput, ThinkRequest, Thinker, ThoughtDraft } from '../../src/kernel/thinking/index.ts'
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/types.ts'

const vocabulary = { ...DEFAULT_VOCABULARY, emotions: ['neutral', 'smug'] }

function request(inputs: ThinkInput[], previous: ThoughtDraft | null = null, chainDepth = 0): ThinkRequest {
  return { inputs, previous, chainDepth, persona: '测试角色', situation: '测试情境', recent: [], vocabulary }
}

function draft(overrides: Partial<ThoughtDraft> = {}): ThoughtDraft {
  return { heard: '话', meant: '话', meantConf: 0.9, turn: 'done', decision: 'reply', emotion: 'neutral', chainDepth: 0, ...overrides }
}

class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted'
  readonly model = 'scripted'
  readonly requests: LLMRequest[] = []
  #replies: string[]
  constructor(replies: string[]) { this.#replies = replies }
  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(req)
    const text = this.#replies.shift()
    if (text === undefined) throw new Error('no more replies')
    return { text, provider: this.name, model: this.model, usage: null, latencyMs: 0 }
  }
}

describe('thinker output', () => {
  it('normalizes unknown values and keeps known ones', () => {
    const parsed = parseThought('```json\n{"heard":"手表多少钱","meant":"收表多少钱","meantConf":1.7,"turn":"asking_me","decision":"dance","emotion":"furious","intensity":2,"reason":"他问了价"}\n```',
      request([{ kind: 'speech', text: '手表多少钱' }]))!
    assert.equal(parsed.meantConf, 1)
    assert.equal(parsed.turn, 'asking_me')
    assert.equal(parsed.decision, 'silent', 'unknown decisions fall back to silence')
    assert.equal(parsed.emotion, 'neutral')
    assert.equal(parsed.intensity, 2)
    assert.equal(parsed.reason, '他问了价')
  })

  it('rejects prose and arrays', () => {
    assert.equal(parseThought('我觉得应该回复', request([])), null)
    assert.equal(parseThought('[1,2]', request([])), null)
  })

  it('a failing or rambling model yields a reply fallback, not silence', async () => {
    const thinker = new LlmThinker({ provider: new ScriptedProvider(['好的，我来想想']) })
    const result = await thinker.think(request([{ kind: 'speech', text: '你好' }]))
    assert.equal(result.fallback, true)
    assert.equal(result.decision, 'reply')
    const broken = new LlmThinker({ provider: new ScriptedProvider([]) })
    assert.equal((await broken.think(request([{ kind: 'speech', text: '你好' }]))).fallback, true)
  })

  it('sends no completion cap by default, and a fallback says why it happened', async () => {
    const provider: LLMProvider & { requests: LLMRequest[] } = {
      name: 'reasoning', model: 'reasoning', requests: [],
      // A reasoning model that ran out of tokens before writing any content.
      async complete(req) { provider.requests.push(req); return { text: '', provider: 'reasoning', model: 'reasoning', usage: null, latencyMs: 0, finishReason: 'length', reasoningChars: 1320 } },
    }
    const result = await new LlmThinker({ provider }).think(request([{ kind: 'speech', text: '你好' }]))
    assert.equal(provider.requests[0]!.maxTokens, 0)
    assert.equal(result.fallback, true)
    assert.match(result.reason ?? '', /empty output \(finish length, reasoning 1320 chars\)/)
  })

  it('CHARACTERLIFE_THINK_REASONING=off asks the endpoint not to reason', async () => {
    const { thinkProviderFromEnv } = await import('../../src/api/runtime-factory.ts')
    const { DeepSeekProvider } = await import('../../src/conversation/providers/deepseek.ts')
    const env = { CHARACTERLIFE_THINK_BASE_URL: 'https://example.invalid/v3', CHARACTERLIFE_THINK_MODEL: 'm', CHARACTERLIFE_THINK_API_KEY: 'test-key' }
    assert.ok(thinkProviderFromEnv({ ...env, CHARACTERLIFE_THINK_REASONING: 'off' }) instanceof DeepSeekProvider)
    // The extra body field reaches the wire.
    const bodies: Array<Record<string, unknown>> = []
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body))
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const off = new DeepSeekProvider({ apiKey: 'k', baseUrl: 'https://example.invalid/v3', model: 'm', fetchImpl, extraBody: { thinking: { type: 'disabled' } } })
    await off.complete({ system: 's', messages: [{ role: 'user', content: 'u' }], temperature: 0, maxTokens: 0, jsonMode: true })
    assert.deepEqual(bodies[0]!.thinking, { type: 'disabled' })
    assert.equal('max_tokens' in bodies[0]!, false)
    const plain = new DeepSeekProvider({ apiKey: 'k', baseUrl: 'https://example.invalid/v3', model: 'm', fetchImpl })
    await plain.complete({ system: 's', messages: [{ role: 'user', content: 'u' }], temperature: 0, maxTokens: 0, jsonMode: true })
    assert.equal('thinking' in bodies[1]!, false, 'off by default')
  })

  it('the prompt carries the previous thought when continuing, and the vocabulary', () => {
    const prompt = buildThinkerPrompt(request([{ kind: 'speech', text: '还有一件事' }], draft({ meant: '房租交了' }), 1))
    assert.match(prompt.user, /接着想/)
    assert.match(prompt.user, /房租交了/)
    assert.match(prompt.system, /silent\|reply\|ask/)
    assert.match(prompt.system, /neutral\|smug/)
  })
})

describe('thinking loop', () => {
  class QueueThinker implements Thinker {
    readonly seen: Array<{ inputs: string[]; previous: string | null; chainDepth: number }> = []
    #onThink: (count: number) => void
    #turn: string
    constructor(onThink: (count: number) => void = () => {}, turn = 'done') { this.#onThink = onThink; this.#turn = turn }
    async think(req: ThinkRequest): Promise<ThoughtDraft> {
      this.seen.push({ inputs: req.inputs.map((input) => input.text), previous: req.previous?.meant ?? null, chainDepth: req.chainDepth })
      this.#onThink(this.seen.length)
      return draft({ meant: req.inputs.map((input) => input.text).join('+'), turn: this.#turn, chainDepth: req.chainDepth })
    }
  }

  it('input arriving during a step continues the same thought, at most three times', async () => {
    const queue: ThinkInput[] = []
    // Every step, the host says one more thing.
    const thinker = new QueueThinker((count) => { queue.push({ kind: 'speech', text: `补充${count}` }) })
    const loop = new ThinkingLoop({ thinker, holdMs: 0 })
    const result = await loop.run({ inputs: [{ kind: 'speech', text: '开头' }], drain: () => queue.splice(0), build: (inputs, previous, depth) => request([...inputs], previous, depth) })
    assert.equal(result.chainDepth, 3)
    assert.deepEqual(thinker.seen.map((step) => step.chainDepth), [0, 1, 2, 3])
    assert.equal(thinker.seen[1]!.previous, '开头', 'continues from the previous thought')
    assert.deepEqual(thinker.seen[1]!.inputs, ['补充1'], 'only the new input, not everything again')
    assert.deepEqual(result.inputs.map((input) => input.text), ['开头', '补充1', '补充2', '补充3'])
    assert.equal(queue.length, 1, 'input after the forced decision stays queued for the next turn')
  })

  it('waits briefly when the other party is still talking', async () => {
    const queue: ThinkInput[] = []
    const thinker = new QueueThinker(() => {}, 'pausing')
    let slept = 0
    const loop = new ThinkingLoop({ thinker, holdMs: 1500, sleep: async (ms) => { slept += ms; if (slept === 1500) queue.push({ kind: 'speech', text: '说完了' }) } })
    const result = await loop.run({ inputs: [{ kind: 'speech', text: '我想想然后' }], drain: () => queue.splice(0), build: (inputs, previous, depth) => request([...inputs], previous, depth) })
    assert.equal(result.chainDepth, 1)
    assert.deepEqual(result.inputs.map((input) => input.text), ['我想想然后', '说完了'])
  })
})

describe('decision rules', () => {
  const ctx = (overrides: Partial<Parameters<typeof decideThought>[1]> = {}) => ({
    allowed: ['silent', 'reply', 'ask', 'challenge', 'tease'], speakThreshold: 0.6, willingness: new Willingness(), vocabulary,
    nowSim: 0, addressed: false, events: 0, utterances: 1, ...overrides,
  })

  it('silence below the threshold is a recorded decision with its reason', () => {
    const result = decideThought(draft({ decision: 'tease' }), ctx())
    assert.equal(result.decision, 'silent')
    assert.equal(result.proposed, 'tease')
    assert.match(result.ruling, /below threshold/)
  })

  it('being addressed or asked lets her speak', () => {
    assert.equal(decideThought(draft({ decision: 'tease' }), ctx({ addressed: true })).decision, 'tease')
    assert.equal(decideThought(draft({ decision: 'silent', turn: 'asking_me' }), ctx()).decision, 'reply', 'a direct question is always answered')
  })

  it('low confidence on a line that needs an answer turns into a short question', () => {
    const result = decideThought(draft({ decision: 'reply', turn: 'asking_me', meantConf: 0.3 }), ctx())
    assert.equal(result.decision, 'ask')
  })

  it('decisions the stage does not allow fall back to a plain reply', () => {
    const result = decideThought(draft({ decision: 'advise' }), ctx({ addressed: true }))
    assert.equal(result.decision, 'reply')
    assert.match(result.ruling, /not allowed/)
  })

  it('a thinker failure keeps the old behavior instead of going mute', () => {
    assert.equal(decideThought(draft({ decision: 'reply', fallback: true }), ctx()).decision, 'reply')
  })
})

describe('willingness', () => {
  it('rises with address, drops after speaking and drifts back to the base', () => {
    const w = new Willingness()
    assert.equal(w.observe({ addressed: true, question: false, events: 0, utterances: 0 }, 0), 0.7)
    w.spoke(0)
    assert.ok(Math.abs(w.value(0) - 0.4) < 1e-9)
    // 0.2 per minute toward the base of 0.3.
    assert.ok(Math.abs(w.value(30_000) - 0.3) < 1e-9)
  })

  it('several unanswered lines add up', () => {
    const w = new Willingness()
    let value = 0
    for (let i = 0; i < 4; i++) value = w.observe({ addressed: false, question: false, events: 0, utterances: 1 }, i * 1000)
    assert.ok(value > 0.45)
  })
})
