/**
 * Telegram adapter tests (offline: MockTransport, no bot token, no network).
 *
 * Covers:
 * 1. Update parsing: private chats only, anonymized ids, command @suffix, stickers
 * 2. Sending: bubble split, typing pause, error mapping, partial-delivery retry rule
 * 3. Poller end to end: allowlist, /start welcome without creating an instance, chat via gateway,
 *    /start <code> deep-link binding to an existing instance, dedupe on redelivery, 401 stops
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { assembleRuntime } from '../../src/api/runtime-factory.ts'
import type { RuntimeBundle } from '../../src/api/runtime-factory.ts'
import { MockProvider } from '../../src/conversation/providers/mock.ts'
import { ManualClock } from '../../src/kernel/util/clock.ts'
import { MockTransport, TelegramApiClient } from '../../src/adapters/telegram/api-client.ts'
import { TelegramAdapter, splitIntoBubbles, TELEGRAM_MAX_TEXT } from '../../src/adapters/telegram/adapter.ts'
import {
  anonymizeTelegramUserId,
  encodeReplyTarget,
  parseTelegramUpdate,
} from '../../src/adapters/telegram/events.ts'
import { createTelegramPoller } from '../../src/adapters/telegram/poller.ts'
import { cleanupDirs, freshDir } from './helpers.ts'

after(() => cleanupDirs())

const USER_ID = 424242
const STRANGER_ID = 777

let updateSeq = 100
function privateUpdate(opts: { messageId: number; text?: string; userId?: number; sticker?: string }): Record<string, unknown> {
  const userId = opts.userId ?? USER_ID
  const message: Record<string, unknown> = {
    message_id: opts.messageId,
    date: 1_700_000_000,
    chat: { id: userId, type: 'private' },
    from: { id: userId, is_bot: false, first_name: 'Alice' },
  }
  if (opts.text !== undefined) message.text = opts.text
  if (opts.sticker !== undefined) message.sticker = { emoji: opts.sticker }
  return { update_id: ++updateSeq, message }
}

function makeRuntime(transport: MockTransport): RuntimeBundle {
  return assembleRuntime({
    dbPath: join(freshDir(), 'telegram.db'),
    worldId: 'world_test',
    provider: new MockProvider({ mode: 'in-character' }),
    clock: new ManualClock(0),
    telegram: { token: 'test-token', transport, typingMsPerChar: 0 },
  })
}

function sentTexts(transport: MockTransport): string[] {
  return transport.calls('sendMessage').map((r) => String(r.params.text))
}

describe('Telegram · Update parsing', () => {
  it('private text message → c2c, anonymized id, chat id in reply target', () => {
    const msg = parseTelegramUpdate(privateUpdate({ messageId: 5, text: '你好' }))
    assert.ok(msg)
    assert.equal(msg.platform, 'telegram')
    assert.equal(msg.platformMessageId, `${USER_ID}:5`)
    assert.equal(msg.scene, 'c2c')
    assert.equal(msg.text, '你好')
    assert.equal(msg.trust, 'untrusted')
    assert.equal(msg.identity.platformUserId, anonymizeTelegramUserId(USER_ID))
    assert.ok(!msg.identity.platformUserId.includes(String(USER_ID)))
    assert.equal(msg.identity.displayName, undefined, 'names are not captured by default')
    assert.equal(msg.replyTarget, encodeReplyTarget({ chatId: USER_ID }))
    assert.equal(msg.timestamp, 1_700_000_000_000)
  })

  it('group messages, bot senders and unsupported types are ignored', () => {
    const group = privateUpdate({ messageId: 6, text: 'hi' })
    ;(group.message as Record<string, unknown>).chat = { id: -100, type: 'group' }
    assert.equal(parseTelegramUpdate(group), null)
    const bot = privateUpdate({ messageId: 7, text: 'hi' })
    ;((bot.message as Record<string, unknown>).from as Record<string, unknown>).is_bot = true
    assert.equal(parseTelegramUpdate(bot), null)
    assert.equal(parseTelegramUpdate(privateUpdate({ messageId: 8 })), null, 'no text, caption or sticker')
    assert.equal(parseTelegramUpdate({ update_id: 1, edited_message: {} }), null)
  })

  it('strips @BotName from commands and turns stickers into a short note', () => {
    assert.equal(parseTelegramUpdate(privateUpdate({ messageId: 9, text: '/status@cl_bot' }))?.text, '/status')
    assert.equal(parseTelegramUpdate(privateUpdate({ messageId: 10, sticker: '😀' }))?.text, '（贴纸 😀）')
  })
})

describe('Telegram · sending', () => {
  it('splits on blank lines, caps bubble count and per-message length', () => {
    assert.deepEqual(splitIntoBubbles('a\n\nb\n\nc\n\nd', { splitParagraphs: true, maxBubbles: 3 }), ['a', 'b', 'c\n\nd'])
    assert.deepEqual(splitIntoBubbles('a\n\nb', { splitParagraphs: false, maxBubbles: 3 }), ['a\n\nb'])
    const long = 'x'.repeat(TELEGRAM_MAX_TEXT + 10)
    const parts = splitIntoBubbles(long, { splitParagraphs: true, maxBubbles: 3 })
    assert.equal(parts.length, 2)
    assert.ok(parts.every((p) => p.length <= TELEGRAM_MAX_TEXT))
    assert.deepEqual(splitIntoBubbles('   ', { splitParagraphs: true, maxBubbles: 3 }), [])
  })

  it('sends bubbles in order with a typing pause between them', async () => {
    const transport = new MockTransport()
    const pauses: number[] = []
    const adapter = new TelegramAdapter({
      client: new TelegramApiClient({ transport }),
      sleep: async (ms) => {
        pauses.push(ms)
      },
    })
    const result = await adapter.send({
      platform: 'telegram',
      identity: { platform: 'telegram', platformUserId: 'tg_x' },
      scene: 'c2c',
      sceneId: null,
      replyTarget: encodeReplyTarget({ chatId: USER_ID }),
      replyToMessageId: null,
      text: '第一句\n\n第二句话长一点',
      proactive: false,
    })
    assert.equal(result.ok, true)
    assert.deepEqual(sentTexts(transport), ['第一句', '第二句话长一点'])
    assert.equal(transport.calls('sendChatAction').length, 1)
    assert.deepEqual(pauses, ['第二句话长一点'.length * 40])
    assert.equal(transport.calls('sendMessage')[0]!.params.chat_id, USER_ID)
    assert.equal(transport.calls('sendMessage')[0]!.params.parse_mode, undefined, 'plain text, never parse_mode')
  })

  it('maps 403 / 429 / 5xx and only allows a retry before anything was delivered', async () => {
    const transport = new MockTransport()
    const adapter = new TelegramAdapter({ client: new TelegramApiClient({ transport }), typingMsPerChar: 0 })
    const base = {
      platform: 'telegram',
      identity: { platform: 'telegram', platformUserId: 'tg_x' },
      scene: 'c2c' as const,
      sceneId: null,
      replyTarget: encodeReplyTarget({ chatId: USER_ID }),
      replyToMessageId: null,
      proactive: true,
    }
    transport.enqueue('sendMessage', { status: 403, body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } })
    const blocked = await adapter.send({ ...base, text: 'hi' })
    assert.equal(blocked.error?.code, 'NO_PERMISSION')
    assert.equal(blocked.error?.retryable, false)

    transport.enqueue('sendMessage', { status: 429, body: { ok: false, error_code: 429, parameters: { retry_after: 3 } } })
    const limited = await adapter.send({ ...base, text: 'hi' })
    assert.equal(limited.error?.code, 'RATE_LIMITED')

    transport.enqueue('sendMessage', { status: 200, body: { ok: true, result: { message_id: 9 } } })
    transport.enqueue('sendMessage', { status: 502, body: { ok: false, error_code: 502 } })
    const partial = await adapter.send({ ...base, text: 'a\n\nb' })
    assert.equal(partial.ok, false)
    assert.equal(partial.platformMessageId, `${USER_ID}:9`)
    assert.equal(partial.error?.retryable, false, 'first bubble already delivered: no resend')
  })

  it('queues proactive messages when proactive is disabled', async () => {
    const transport = new MockTransport()
    const adapter = new TelegramAdapter({ client: new TelegramApiClient({ transport }), capabilities: { proactive: false } })
    const result = await adapter.send({
      platform: 'telegram',
      identity: { platform: 'telegram', platformUserId: 'tg_x' },
      scene: 'c2c',
      sceneId: null,
      replyTarget: encodeReplyTarget({ chatId: USER_ID }),
      replyToMessageId: null,
      text: '早安',
      proactive: true,
    })
    assert.equal(result.queued, true)
    assert.equal(transport.calls('sendMessage').length, 0)
  })
})

describe('Telegram · poller end to end', () => {
  async function runBatch(runtime: RuntimeBundle, transport: MockTransport, updates: unknown[], allowed: string[] | null = [String(USER_ID)]) {
    const logs: string[] = []
    transport.enqueue('getUpdates', { status: 200, body: { ok: true, result: updates } })
    const poller = createTelegramPoller({
      runtime,
      allowedUserIds: allowed ? new Set(allowed) : null,
      logger: (line) => logs.push(line),
      sleep: async () => {},
    })
    void poller.start()
    // Wait until the scripted batch has been fetched and dispatched
    for (let i = 0; i < 200 && transport.calls('getUpdates').length < 2; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.ok(await poller.waitIdle(5000))
    await poller.stop()
    return { logs, offset: poller.offset }
  }

  it('ignores users outside the allowlist and logs their id once', async () => {
    const transport = new MockTransport()
    const runtime = makeRuntime(transport)
    const { logs } = await runBatch(runtime, transport, [
      privateUpdate({ messageId: 1, text: '在吗', userId: STRANGER_ID }),
      privateUpdate({ messageId: 2, text: '在吗', userId: STRANGER_ID }),
    ])
    assert.equal(transport.calls('sendMessage').length, 0)
    assert.equal(logs.filter((l) => l.includes(String(STRANGER_ID))).length, 1)
    assert.equal(runtime.identityService.instanceFor('telegram', anonymizeTelegramUserId(STRANGER_ID)), null)
    runtime.close()
  })

  it('/start replies a welcome without creating an instance; chat then goes through the gateway', async () => {
    const transport = new MockTransport()
    const runtime = makeRuntime(transport)
    const pseudo = anonymizeTelegramUserId(USER_ID)

    const first = await runBatch(runtime, transport, [privateUpdate({ messageId: 1, text: '/start' })])
    assert.equal(transport.calls('sendMessage').length, 1)
    assert.match(sentTexts(transport)[0]!, /\/link/)
    assert.equal(runtime.identityService.instanceFor('telegram', pseudo), null, '/start must not create an instance')
    assert.equal(first.offset, updateSeq + 1)

    await runBatch(runtime, transport, [privateUpdate({ messageId: 2, text: '今天好累' })])
    assert.ok(runtime.identityService.instanceFor('telegram', pseudo), 'chatting creates the instance')
    assert.equal(transport.calls('sendMessage').length >= 2, true, 'model reply delivered')
    assert.ok(transport.calls('sendChatAction').length >= 1, 'typing shown while the model runs')
    runtime.close()
  })

  it('/start <code> binds Telegram to an existing instance; redelivery is deduplicated', async () => {
    const transport = new MockTransport()
    const runtime = makeRuntime(transport)
    // An existing desktop (SillyTavern-protocol) identity issues a code for Telegram
    const desktop = runtime.identityService.resolveOrCreate('sillytavern', 'local-default')
    const issued = runtime.identityService.issueBindCode({
      instanceId: desktop.instance.id,
      targetPlatform: 'telegram',
      createdBy: 'sillytavern:local-default',
    })
    const deepLink = privateUpdate({ messageId: 1, text: `/start ${issued.code}` })
    await runBatch(runtime, transport, [deepLink])
    assert.equal(runtime.identityService.instanceFor('telegram', anonymizeTelegramUserId(USER_ID)), desktop.instance.id)
    assert.match(sentTexts(transport).at(-1)!, /绑定好了/)

    const before = transport.calls('sendMessage').length
    await runBatch(runtime, transport, [deepLink])
    assert.equal(transport.calls('sendMessage').length, before, 'same update redelivered after restart: no second reply')
    runtime.close()
  })

  it('/link refuses without consuming the code when this account already has its own instance', async () => {
    const transport = new MockTransport()
    const runtime = makeRuntime(transport)
    await runBatch(runtime, transport, [privateUpdate({ messageId: 1, text: '你好' })])
    const own = runtime.identityService.instanceFor('telegram', anonymizeTelegramUserId(USER_ID))
    const desktop = runtime.identityService.resolveOrCreate('sillytavern', 'local-default')
    const issued = runtime.identityService.issueBindCode({
      instanceId: desktop.instance.id,
      targetPlatform: 'telegram',
      createdBy: 'sillytavern:local-default',
    })
    await runBatch(runtime, transport, [privateUpdate({ messageId: 2, text: `/link ${issued.code}` })])
    assert.match(sentTexts(transport).at(-1)!, /\/unbind/)
    assert.equal(runtime.identityService.instanceFor('telegram', anonymizeTelegramUserId(USER_ID)), own)
    // The code is still usable by another account
    const other = runtime.identityService.redeemBindCode({ code: issued.code, platform: 'telegram', platformUserId: 'tg_other' })
    assert.equal(other.ok, true)
    runtime.close()
  })

  it('stops polling on 401 (invalid token)', async () => {
    const transport = new MockTransport()
    const runtime = makeRuntime(transport)
    transport.enqueue('getUpdates', { status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } })
    const logs: string[] = []
    const poller = createTelegramPoller({ runtime, allowedUserIds: null, logger: (l) => logs.push(l), sleep: async () => {} })
    await poller.start()
    assert.equal(transport.calls('getUpdates').length, 1)
    assert.ok(logs.some((l) => l.includes('401')))
    assert.ok(logs.every((l) => !l.includes('test-token')), 'token never logged')
    runtime.close()
  })
})
