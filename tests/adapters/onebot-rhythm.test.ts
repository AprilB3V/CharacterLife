/**
 * OneBot reply rhythm: a wait window that merges follow-up messages into one turn, and replies
 * sent line by line without trailing full stops.
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { assembleRuntime, parseWaitRange } from '../../src/api/runtime-factory.ts'
import { MockProvider } from '../../src/conversation/providers/mock.ts'
import type { LLMRequest, LLMResponse } from '../../src/kernel/types.ts'
import { ManualClock } from '../../src/kernel/util/clock.ts'
import { OneBotAdapter } from '../../src/adapters/onebot/adapter.ts'
import type { OneBotApiClient } from '../../src/adapters/onebot/api-client.ts'
import { encodeReplyTarget } from '../../src/adapters/onebot/events.ts'
import { createOneBotReportServer } from '../../src/adapters/onebot/report-server.ts'
import { splitReply } from '../../src/adapters/onebot/split.ts'
import { cleanupDirs, freshDir, oneBotPrivateEvent } from './helpers.ts'

after(() => cleanupDirs())

describe('OneBot · reply splitting', () => {
  it('one message per line, trailing full stops dropped, ? ! and … kept', () => {
    assert.deepEqual(splitReply('行吧。\n\n你先说清楚是哪本书？\n我看看…'), ['行吧', '你先说清楚是哪本书？', '我看看…'])
    assert.deepEqual(splitReply('就这样。。'), ['就这样'])
    assert.deepEqual(splitReply('a\nb\nc\nd\ne', { maxParts: 3 }), ['a', 'b', 'c\nd\ne'])
    assert.deepEqual(splitReply(' \n '), [])
  })

  it('parses wait ranges from the environment', () => {
    assert.deepEqual(parseWaitRange('3000-5000'), { minMs: 3000, maxMs: 5000 })
    assert.deepEqual(parseWaitRange('4000'), { minMs: 4000, maxMs: 4000 })
    assert.equal(parseWaitRange('0'), null)
    assert.equal(parseWaitRange('abc'), null)
  })
})

function fakeClient(fail: (index: number) => boolean = () => false) {
  const sent: string[] = []
  const client = {
    async sendPrivate(opts: { text: string }) {
      const index = sent.length
      sent.push(opts.text)
      if (fail(index)) return { status: 'failed', retcode: 100, data: {}, httpStatus: 500 }
      return { status: 'ok', retcode: 0, data: { message_id: 100 + index }, httpStatus: 200 }
    },
    async sendGroup() { throw new Error('unused') },
    describe: () => 'fake',
  } as unknown as OneBotApiClient
  return { client, sent }
}

const outbound = (text: string) => ({
  platform: 'onebot', identity: { platform: 'onebot', platformUserId: 'u' }, scene: 'c2c' as const,
  sceneId: null, replyTarget: encodeReplyTarget({ scene: 'c2c', target: '20002' }), replyToMessageId: null, text, proactive: false,
})

describe('OneBot · split sending', () => {
  it('sends each line as its own message with a pause in between', async () => {
    const { client, sent } = fakeClient()
    const pauses: number[] = []
    const adapter = new OneBotAdapter({ client, splitReplies: true, sleep: async (ms) => { pauses.push(ms) } })
    const result = await adapter.send(outbound('行吧。\n你先说是哪本书'))
    assert.equal(result.ok, true)
    assert.deepEqual(sent, ['行吧', '你先说是哪本书'])
    assert.equal(pauses.length, 1)
    assert.equal(result.platformMessageId, '101')
  })

  it('off by default: one message, text untouched', async () => {
    const { client, sent } = fakeClient()
    await new OneBotAdapter({ client }).send(outbound('行吧。\n你先说'))
    assert.deepEqual(sent, ['行吧。\n你先说'])
  })

  it('a failure after the first part is not retried, so earlier parts are not sent twice', async () => {
    const { client } = fakeClient((i) => i === 1)
    const adapter = new OneBotAdapter({ client, splitReplies: true, sleep: async () => {} })
    const result = await adapter.send(outbound('一\n二'))
    assert.equal(result.ok, false)
    assert.equal(result.error?.retryable, false)
  })
})

describe('OneBot · wait window', () => {
  it('merges messages sent during the wait into one turn and settles every message id', async () => {
    const seen: string[] = []
    const mock = new MockProvider({ mode: 'in-character' })
    const provider = {
      name: mock.name,
      model: mock.model,
      async complete(request: LLMRequest): Promise<LLMResponse> {
        const last = [...request.messages].reverse().find((m) => m.role === 'user')
        seen.push(String(request.meta?.userText ?? last?.content ?? ''))
        return mock.complete(request)
      },
    }
    const { client, sent } = fakeClient()
    const runtime = assembleRuntime({
      dbPath: join(freshDir(), 'onebot-rhythm.db'),
      worldId: 'world_onebot_rhythm',
      provider,
      clock: new ManualClock(0),
      onebot: { baseUrl: 'http://127.0.0.1:1', parse: { selfId: 10001 } },
    })
    // Swap in the fake client by re-registering an adapter that uses it.
    runtime.gateway.registerAdapter(new OneBotAdapter({ client, parse: { selfId: 10001 } }))
    Object.assign(runtime, { onebotAdapter: runtime.gateway.adapter('onebot') })
    const report = createOneBotReportServer({ runtime, port: 0, logger: () => {}, replyWait: { minMs: 300, maxMs: 300 } })
    await report.listen()
    const post = (id: number, text: string) => fetch(`${report.url}/onebot/event`, {
      method: 'POST', headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify(oneBotPrivateEvent({ id, userId: 20002, text })),
    })
    try {
      assert.equal((await post(1, '我有本旧书')).status, 204)
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal((await post(2, '被水泡过')).status, 204)
      assert.equal(sent.length, 0, 'nothing is sent during the wait')
      assert.equal(await report.waitIdle(), true)
      assert.equal(seen.length, 1, 'one model turn for both messages')
      assert.match(seen[0]!, /我有本旧书\n被水泡过/)
      assert.equal(sent.length, 1)

      // Both ids are settled: a redelivery of either one is a duplicate.
      await post(1, '我有本旧书')
      await report.waitIdle()
      assert.equal(seen.length, 1)

      // Commands answer at once.
      const before = sent.length
      await post(3, '/help')
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal(sent.length, before + 1)
    } finally {
      await report.close()
      runtime.close()
    }
  })
})
