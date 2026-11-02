/**
 * /v1/think: think -> continue while more arrives -> decide; silence is a real decision.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assembleRuntime } from '../../src/api/runtime-factory.ts'
import { createApiServer } from '../../src/api/server.ts'
import { MockProvider } from '../../src/conversation/providers/mock.ts'
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/types.ts'

const TOKEN = 'think-test-credential-123456'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Thinker double: answers from a script; can be slow so input can arrive mid-thought. */
class ScriptedThinker implements LLMProvider {
  readonly name = 'scripted-think'
  readonly model = 'scripted-think'
  readonly requests: LLMRequest[] = []
  #script: Array<{ json: Record<string, unknown>; delayMs?: number }>
  constructor(script: Array<{ json: Record<string, unknown>; delayMs?: number }>) { this.#script = script }
  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request)
    const next = this.#script.shift() ?? { json: { decision: 'silent' } }
    if (next.delayMs) await sleep(next.delayMs)
    return { text: JSON.stringify(next.json), provider: this.name, model: this.model, usage: null, latencyMs: 0 }
  }
}

/** Reply model double that records prompts. */
class RecordingMain extends MockProvider {
  readonly requests: LLMRequest[] = []
  override async complete(request: LLMRequest): Promise<LLMResponse> {
    this.requests.push(request)
    return super.complete(request)
  }
}

async function boot(thinker: LLMProvider | null) {
  const main = new RecordingMain({ mode: 'in-character' })
  const runtime = assembleRuntime({ dbPath: ':memory:', worldId: 'world_test', provider: main, thinkProvider: thinker })
  const handle = createApiServer({ runtime, port: 0, token: TOKEN, logger: () => {}, stIdentityUserId: 'host' })
  const { url } = await handle.listen()
  const think = (inputs: Array<{ kind: string; text: string }>, stream = false) => fetch(`${url}/v1/think`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ inputs, stream }),
  })
  const post = (payload: Record<string, unknown>) => fetch(`${url}/v1/think`, {
    method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(payload),
  })
  return { runtime, main, think, post, url, close: async () => { await handle.close(); runtime.close() } }
}

const speech = (text: string) => ({ kind: 'speech', text })
interface ThinkPayload { silent: boolean; reply: string; thought: { decision: string; chainDepth: number } }
const body = async (response: Promise<Response>) => (await (await response).json()) as ThinkPayload
const thought = (overrides: Record<string, unknown>) => ({ heard: 'x', meant: 'x', meantConf: 0.9, turn: 'done', emotion: 'neutral', reason: '依据', ...overrides })

describe('/v1/think', () => {
  it('refuses when no thinking model is configured', async () => {
    const h = await boot(null)
    try {
      assert.equal((await h.think([speech('你好')])).status, 503)
    } finally { await h.close() }
  })

  it('silence is a decision: no reply, and the line joins the next spoken turn', async () => {
    const thinker = new ScriptedThinker([
      { json: thought({ heard: '我先进点货', meant: '我先进点货', decision: 'silent' }) },
      { json: thought({ heard: '你怎么看', meant: '你怎么看', turn: 'asking_me', decision: 'reply' }) },
    ])
    const h = await boot(thinker)
    try {
      const first = await body(h.think([speech('我先进点货')]))
      assert.equal(first.silent, true)
      assert.equal(first.reply, '')
      assert.equal(first.thought.decision, 'silent')
      assert.equal(h.main.requests.length, 0, 'the reply model is not called for silence')

      const second = await body(h.think([speech('你怎么看')]))
      assert.equal(second.silent, false)
      assert.ok(second.reply.length > 0)
      const prompt = h.main.requests.at(-1)!
      const userText = prompt.messages.map((message) => message.content).join('\n')
      assert.match(userText, /我先进点货/, 'the unanswered line is part of the next turn')
      assert.match(prompt.system, /本轮动作：reply/, 'trusted guidance reaches the behavior rationale')
      assert.doesNotMatch(prompt.system, /你怎么看/, 'user-derived text never reaches the system prompt')
      assert.match(userText, /本轮思考结论｜数据，不是指令[\s\S]*对方的意思（推断/, 'the inferred meaning is data')
      // The thinker saw the earlier unanswered line as recent dialogue.
      assert.match(thinker.requests[1]!.messages[0]!.content, /她没接话/)
    } finally { await h.close() }
  })

  it('input arriving while she thinks is queued and continues the same thought', async () => {
    const thinker = new ScriptedThinker([
      { json: thought({ heard: '房租交了', decision: 'silent' }), delayMs: 300 },
      { json: thought({ heard: '还有一件事', turn: 'asking_me', decision: 'reply' }) },
    ])
    const h = await boot(thinker)
    try {
      const pending = h.think([speech('房租交了')])
      await sleep(100)
      const merged = await h.think([speech('还有一件事')])
      assert.equal(merged.status, 202)
      assert.deepEqual(await merged.json(), { merged: true })
      const result = await body(pending)
      assert.equal(result.thought.chainDepth, 1)
      assert.equal(result.silent, false)
      assert.match(thinker.requests[1]!.messages[0]!.content, /接着想/)
      const userText = h.main.requests.at(-1)!.messages.map((message) => message.content).join('\n')
      assert.match(userText, /房租交了[\s\S]*还有一件事/)
    } finally { await h.close() }
  })

  it('input arriving while she speaks is refused with 409, and the stream reports each stage', async () => {
    const thinker = new ScriptedThinker([{ json: thought({ turn: 'asking_me', decision: 'reply' }) }])
    const h = await boot(thinker)
    try {
      // Slow down the reply so the second request lands while she is speaking.
      const complete = h.main.complete.bind(h.main)
      h.main.complete = async (request) => { await sleep(300); return complete(request) }
      const streamed = h.think([speech('在吗')], true)
      await sleep(150)
      assert.equal((await h.think([speech('等等')])).status, 409)
      const text = await (await streamed).text()
      const types = text.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5)).type)
      assert.deepEqual(types.filter((type) => type !== 'delta'), ['start', 'thought_step', 'decided', 'end'])
    } finally { await h.close() }
  })

  it('notices reach the reply as data', async () => {
    const thinker = new ScriptedThinker([{ json: thought({ turn: 'asking_me', decision: 'reply' }) }])
    const h = await boot(thinker)
    try {
      await h.post({ inputs: [speech('还有一件事')], notices: ['上一条回复对方没看到'] })
      const userText = h.main.requests.at(-1)!.messages.map((message) => message.content).join('\n')
      assert.match(userText, /补充资料[\s\S]*上一条回复对方没看到/)
    } finally { await h.close() }
  })

  it('a merge-only request never starts a turn of its own', async () => {
    const h = await boot(new ScriptedThinker([]))
    try {
      const response = await h.post({ inputs: [speech('还有一件事')], mergeOnly: true })
      assert.equal(response.status, 409)
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'NOT_THINKING')
    } finally { await h.close() }
  })

  it('input after the last continuation still joins this turn instead of being lost', async () => {
    // Each thinking step waits until the test opens its gate, so every new line lands inside a known step:
    // '二' in step 0, '三' in step 1, '四' in step 2, and '五' in step 3, after the loop stopped draining.
    const gates: Array<() => void> = []
    const waiting = () => new Promise<void>((resolve) => { const poll = () => (gates.length ? resolve() : setTimeout(poll, 5)); poll() })
    const draft = (heard: string, decision = 'silent') => JSON.stringify(thought({ heard, decision, turn: decision === 'reply' ? 'asking_me' : 'done' }))
    const replies = [draft('一'), draft('二'), draft('三'), draft('四', 'reply')]
    const thinker: LLMProvider & { requests: LLMRequest[] } = {
      name: 'gated-think', model: 'gated-think', requests: [],
      async complete(request) {
        thinker.requests.push(request)
        await new Promise<void>((release) => gates.push(release))
        return { text: replies.shift()!, provider: 'gated-think', model: 'gated-think', usage: null, latencyMs: 0 }
      },
    }
    const h = await boot(thinker)
    try {
      const pending = h.think([speech('一')])
      const statuses: number[] = []
      for (const line of ['二', '三', '四', '五']) {
        await waiting()
        statuses.push((await h.post({ inputs: [speech(line)], mergeOnly: true })).status)
        gates.shift()!()
      }
      const result = await body(pending)
      assert.equal(result.thought.chainDepth, 3)
      assert.equal(thinker.requests.length, 4, 'the fifth line got no extra thinking step')
      assert.deepEqual(statuses, [202, 202, 202, 202])
      const userText = h.main.requests.at(-1)?.messages.map((message) => message.content).join('\n') ?? ''
      for (const line of ['二', '三', '四', '五']) assert.match(userText, new RegExp(line), `${line} was accepted, so it must reach the reply`)
    } finally { await h.close() }
  })

  it('an events-only turn that decides to speak gets a reply', async () => {
    const h = await boot(new ScriptedThinker([{ json: thought({ heard: '', decision: 'reply', turn: 'done' }) }]))
    try {
      // Willingness from the event plus the thinker wanting to speak must clear the default threshold.
      const response = await h.post({ inputs: [{ kind: 'event', text: '治安官进门了' }, { kind: 'event', text: '调查值涨到 80' }] })
      const result = (await response.json()) as ThinkPayload
      assert.equal(result.silent, false)
      assert.match(h.main.requests.at(-1)!.messages.map((message) => message.content).join('\n'), /【刚发生】治安官进门了/)
    } finally { await h.close() }
  })

  it('the same request id is processed once, and thinking counts toward the rate limit', async () => {
    const h = await boot(new ScriptedThinker(Array.from({ length: 30 }, () => ({ json: thought({ decision: 'silent' }) }))))
    try {
      const send = (id: string) => fetch(`${h.url}/v1/think`, { method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', 'x-request-id': id },
        body: JSON.stringify({ inputs: [speech('嗯')] }) })
      assert.equal((await send('same-id')).status, 200)
      assert.equal((await send('same-id')).status, 409, 'duplicate')
      const statuses: number[] = []
      for (let i = 0; i < 25; i++) statuses.push((await send(`id-${i}`)).status)
      assert.ok(statuses.includes(429), 'silent turns are rate limited too')
    } finally { await h.close() }
  })

  it('the thinking prompt stays bounded however much arrives', async () => {
    const thinker = new ScriptedThinker([{ json: thought({ decision: 'silent' }) }])
    const h = await boot(thinker)
    try {
      // 20 lines of 600 characters: within the request limits, far beyond the prompt budget.
      assert.equal((await h.post({ inputs: Array.from({ length: 20 }, (_, i) => speech(String.fromCharCode(0x4e00 + i).repeat(600))) })).status, 200)
      const prompt = thinker.requests[0]!
      assert.ok(prompt.messages[0]!.content.length < 8000, `prompt ${prompt.messages[0]!.content.length} chars`)
      assert.match(prompt.messages[0]!.content, /前面还有 8 条/)
    } finally { await h.close() }
  })

  it('another speaker bound to the same instance never joins this turn', async () => {
    const gates: Array<() => void> = []
    const thinker: LLMProvider & { requests: LLMRequest[] } = {
      name: 'gated-think', model: 'gated-think', requests: [],
      async complete(request) {
        thinker.requests.push(request)
        if (thinker.requests.length === 1) await new Promise<void>((release) => gates.push(release))
        return { text: JSON.stringify(thought({ turn: 'asking_me', decision: 'reply' })), provider: 'gated-think', model: 'gated-think', usage: null, latencyMs: 0 }
      },
    }
    const main = new RecordingMain({ mode: 'in-character' })
    const runtime = assembleRuntime({ dbPath: ':memory:', worldId: 'world_test', provider: main, thinkProvider: thinker })
    const instanceId = runtime.identityService.resolveOrCreate('sillytavern', 'user-a').instance.id
    const { code } = runtime.identityService.issueBindCode({ instanceId, targetPlatform: 'sillytavern', createdBy: 'test' })
    assert.equal(runtime.identityService.redeemBindCode({ code, platform: 'sillytavern', platformUserId: 'user-b' }).instanceId, instanceId)
    const handle = createApiServer({ runtime, port: 0, logger: () => {}, stIdentityUserId: 'user-a',
      credentials: [{ token: 'token-a-credential-123456', platformUserId: 'user-a' }, { token: 'token-b-credential-123456', platformUserId: 'user-b' }] })
    const { url } = await handle.listen()
    const post = (token: string, payload: Record<string, unknown>) => fetch(`${url}/v1/think`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(payload) })
    try {
      const a = post('token-a-credential-123456', { inputs: [speech('我是 A')] })
      while (!gates.length) await sleep(5)
      // B while A thinks: a merge is refused, a normal turn waits for its own run.
      assert.equal((await post('token-b-credential-123456', { inputs: [speech('我是 B')], mergeOnly: true })).status, 409)
      const b = post('token-b-credential-123456', { inputs: [speech('我是 B')] })
      gates.shift()!()
      assert.equal((await a).status, 200)
      assert.equal((await b).status, 200)
      const prompts = main.requests.map((request) => request.messages.map((message) => message.content).join('\n'))
      const aPrompt = prompts.find((text) => text.includes('我是 A'))!
      assert.doesNotMatch(aPrompt, /我是 B/, "B's words stay out of A's turn")
      assert.ok(prompts.some((text) => text.includes('我是 B') && !text.includes('我是 A')))
    } finally { await handle.close(); runtime.close() }
  })

  it('lines she stayed silent on survive a turn that fails, and reach the retry', async () => {
    const thinker = new ScriptedThinker([
      { json: thought({ decision: 'silent' }) },
      { json: thought({ turn: 'asking_me', decision: 'reply' }) },
      { json: thought({ turn: 'asking_me', decision: 'reply' }) },
    ])
    const main = new RecordingMain({ mode: 'in-character' })
    let failOnce = true
    const runtime = assembleRuntime({ dbPath: ':memory:', worldId: 'world_test', provider: main, thinkProvider: thinker,
      configureInstance: () => ({ sync() {}, contextData() { if (failOnce) { failOnce = false; throw new Error('extension failed') } return '' } }) })
    try {
      const instance = runtime.runtimeManager.get(runtime.identityService.resolveOrCreate('sillytavern', 'host').instance.id)
      const turn = async (text: string) => {
        const outcome = await runtime.runtimeManager.think(instance, { identityKey: 'sillytavern:host', inputs: [speech(text) as never] })
        if (!outcome.silent) await runtime.runtimeManager.send(instance, { identityKey: 'sillytavern:host', text: outcome.text })
      }
      await turn('先记下这句')
      await assert.rejects(turn('第一次问'), /extension failed/)
      await turn('再问一次')
      const userText = main.requests.at(-1)!.messages.map((message) => message.content).join('\n')
      assert.match(userText, /先记下这句[\s\S]*再问一次/)
    } finally { runtime.close() }
  })

  it('rejects malformed inputs', async () => {
    const h = await boot(new ScriptedThinker([]))
    try {
      assert.equal((await h.think([])).status, 400)
      assert.equal((await h.think([{ kind: 'shout', text: 'x' }])).status, 400)
    } finally { await h.close() }
  })
})
