/**
 * OneBot 上报服务的端到端测试（真实 HTTP 端口 + 假网关）。
 *
 * 这里不起真 QQ，但走的是**真的 TCP/HTTP**：
 *   假 OneBot 网关（记录收到的 action）
 *        ↑ HTTP API /send_private_msg
 *   本项目的上报服务（真端口、真签名、真 204 应答）
 *        ↑ HTTP POST 事件（真 fetch）
 *   测试代码
 *
 * QQ 官方那条链路的 webhook 服务写在 examples 里，因此只能自签自验；
 * OneBot 这条链路把服务放进 src/adapters 并且这样测，就是为了不重复那个遗憾。
 */

import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { join } from 'node:path'
import { assembleRuntime } from '../../src/api/runtime-factory.ts'
import type { RuntimeBundle } from '../../src/api/runtime-factory.ts'
import { MockProvider } from '../../src/conversation/providers/mock.ts'
import { ManualClock } from '../../src/util/clock.ts'
import { createOneBotReportServer } from '../../src/adapters/onebot/report-server.ts'
import type { OneBotReportServerHandle } from '../../src/adapters/onebot/report-server.ts'
import { hmacSha1Hex } from '../../src/adapters/onebot/webhook.ts'
import { cleanupDirs, freshDir, oneBotGroupEvent, oneBotPrivateEvent } from './helpers.ts'

const SECRET = 'test-secret'
const SELF_ID = 10001
const GROUP_ID = 30003

interface RecordedCall {
  action: string
  body: Record<string, unknown>
  authorization: string | undefined
}

interface FakeGateway {
  url: string
  calls: RecordedCall[]
  close(): Promise<void>
}

/** 假 OneBot 网关：只实现 send_private_msg / send_group_msg / get_login_info。 */
async function startFakeGateway(): Promise<FakeGateway> {
  const calls: RecordedCall[] = []
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const action = (req.url ?? '/').replace(/^\//, '')
      let body: Record<string, unknown> = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      } catch {
        /* 保持空对象 */
      }
      calls.push({ action, body, authorization: req.headers.authorization })
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      if (action === 'get_login_info') {
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: SELF_ID, nickname: '测试机器人' } }))
        return
      }
      if (action === 'send_private_msg' || action === 'send_group_msg') {
        res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 777 } }))
        return
      }
      res.end(JSON.stringify({ status: 'failed', retcode: 1404, data: null }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      })
    },
  }
}

function signedHeaders(rawBody: string, secret = SECRET): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-signature': `sha1=${hmacSha1Hex(rawBody, secret)}`,
    connection: 'close',
  }
}

async function postEvent(target: OneBotReportServerHandle, payload: unknown, headers: Record<string, string> | null): Promise<Response> {
  const body = JSON.stringify(payload)
  return await fetch(`${target.url}/onebot/event`, {
    method: 'POST',
    headers: headers ?? { 'content-type': 'application/json', connection: 'close' },
    body,
  })
}

describe('OneBot · 上报服务（真实 HTTP）', () => {
  let gw: FakeGateway
  let runtime: RuntimeBundle
  let report: OneBotReportServerHandle
  let dbPath: string

  before(async () => {
    gw = await startFakeGateway()
    dbPath = join(freshDir(), 'onebot-http.db')
    runtime = assembleRuntime({
      dbPath,
      worldId: 'world_onebot_http',
      provider: new MockProvider({ mode: 'in-character' }),
      clock: new ManualClock(0),
      onebot: { baseUrl: gw.url, accessToken: 'gw-token', proactive: true, parse: { selfId: SELF_ID } },
    })
    report = createOneBotReportServer({ runtime, secret: SECRET, port: 0, logger: () => {} })
    await report.listen()
  })

  after(async () => {
    await report.close()
    runtime.close()
    await gw.close()
    cleanupDirs()
  })

  it('GET /healthz 报告适配器与签名状态（不含任何用户数据）', async () => {
    const res = await fetch(`${report.url}/healthz`, { headers: { connection: 'close' } })
    assert.equal(res.status, 200)
    const body = (await res.json()) as Record<string, unknown>
    assert.equal(body.ok, true)
    assert.equal(body.service, 'characterlife-onebot')
    assert.equal(body.signature, 'on')
    assert.match(String(body.adapter), /127\.0\.0\.1/)
    assert.ok(!JSON.stringify(body).includes('gw-token'), 'healthz 不能泄露 access_token')
  })

  it('签名正确的事件：立刻 204，随后异步回复到网关', async () => {
    const payload = oneBotPrivateEvent({ id: 9001, userId: 20002, text: '你好，我有一本被水泡过的旧书' })
    const res = await postEvent(report, payload, signedHeaders(JSON.stringify(payload)))
    assert.equal(res.status, 204, '网关不等人：必须立刻 204')

    assert.equal(await report.waitIdle(), true)
    const sent = gw.calls.filter((c) => c.action === 'send_private_msg')
    assert.equal(sent.length, 1)
    assert.equal(sent[0]!.authorization, 'Bearer gw-token')
    assert.equal(sent[0]!.body.user_id, 20002)
    assert.equal(sent[0]!.body.auto_escape, true)
    assert.ok(String(sent[0]!.body.message).length > 0)
  })

  it('网关重投同一条事件：仍 204，但不会再回复一次', async () => {
    const payload = oneBotPrivateEvent({ id: 9001, userId: 20002, text: '你好，我有一本被水泡过的旧书' })
    const res = await postEvent(report, payload, signedHeaders(JSON.stringify(payload)))
    assert.equal(res.status, 204)
    await report.waitIdle()
    assert.equal(gw.calls.filter((c) => c.action === 'send_private_msg').length, 1, '去重表应该拦住重投')
  })

  it('签名错误 / 缺少签名头 → 401，且不产生任何网关调用', async () => {
    const payload = oneBotPrivateEvent({ id: 9002, userId: 20002, text: '伪造的消息' })
    const before = gw.calls.length

    const badSig = await postEvent(report, payload, { 'content-type': 'application/json', 'x-signature': 'sha1=deadbeef', connection: 'close' })
    assert.equal(badSig.status, 401)

    const missing = await postEvent(report, payload, { 'content-type': 'application/json', connection: 'close' })
    assert.equal(missing.status, 401)

    await report.waitIdle()
    assert.equal(gw.calls.length, before, '被拒绝的请求不能触发发送')
  })

  it('群消息只回群，不串到私聊', async () => {
    const payload = oneBotGroupEvent({ id: 9003, userId: 20055, groupId: GROUP_ID, text: '旧书怎么保存？', atSelf: true })
    const res = await postEvent(report, payload, signedHeaders(JSON.stringify(payload)))
    assert.equal(res.status, 204)
    await report.waitIdle()
    const sent = gw.calls.filter((c) => c.action === 'send_group_msg')
    assert.equal(sent.length, 1)
    assert.equal(sent[0]!.body.group_id, GROUP_ID)
    assert.equal(gw.calls.filter((c) => c.action === 'send_private_msg').length, 1, '私聊调用次数不变')
  })

  it('路径与方法错误、坏 JSON 各自有明确状态码', async () => {
    const notFound = await fetch(`${report.url}/nope`, { headers: { connection: 'close' } })
    assert.equal(notFound.status, 404)

    const wrongMethod = await fetch(`${report.url}/onebot/event`, { headers: { connection: 'close' } })
    assert.equal(wrongMethod.status, 405)

    const badJson = await fetch(`${report.url}/onebot/event`, {
      method: 'POST',
      headers: signedHeaders('{not json'),
      body: '{not json',
    })
    assert.equal(badJson.status, 400)
  })
})

describe('OneBot · 上报服务（未配置 secret）', () => {
  it('没配 secret 时接受未签名事件（会打警告日志），符合 OneBot 规范', async () => {
    const gw = await startFakeGateway()
    const dbPath = join(freshDir(), 'onebot-open.db')
    const runtime = assembleRuntime({
      dbPath,
      worldId: 'world_onebot_open',
      provider: new MockProvider({ mode: 'in-character' }),
      clock: new ManualClock(0),
      onebot: { baseUrl: gw.url, parse: { selfId: SELF_ID } },
    })
    const warnings: string[] = []
    const report = createOneBotReportServer({ runtime, secret: null, port: 0, logger: (line) => warnings.push(line) })
    await report.listen()

    try {
      const payload = oneBotPrivateEvent({ id: 9101, userId: 20066, text: '你好' })
      const res = await postEvent(report, payload, null)
      assert.equal(res.status, 204)
      await report.waitIdle()
      assert.equal(gw.calls.filter((c) => c.action === 'send_private_msg').length, 1)
      assert.ok(
        warnings.some((line) => line.includes('未配置 secret')),
        '没配 secret 必须留下警告，而不是静默放行',
      )
    } finally {
      await report.close()
      runtime.close()
      await gw.close()
    }
  })
})
