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
  return { runtime, main, think, post, close: async () => { await handle.close(); runtime.close() } }
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
      assert.match(prompt.system, /思考结论：对方的意思是「你怎么看」/, 'guidance reaches the reply prompt')
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

  it('rejects malformed inputs', async () => {
    const h = await boot(new ScriptedThinker([]))
    try {
      assert.equal((await h.think([])).status, 400)
      assert.equal((await h.think([{ kind: 'shout', text: 'x' }])).status, 400)
    } finally { await h.close() }
  })
})
