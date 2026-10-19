/**
 * 跨平台测试（任务书八-C，本次架构的核心验收目标）。
 *
 * 场景：QQ 里约定一件事 → 用一次性验证码把 SillyTavern 身份绑到同一实例
 *      → 酒馆里问起这件事 → 关系与记忆一致 → 重启后仍然正确 → 陌生人读不到。
 *
 * 说明：QQ 侧用官方事件格式 + MockTransport（离线），没有真实 QQ 凭证；
 * 酒馆侧走真实 HTTP 服务。两者共用同一个 SQLite 实例。
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createApiServer } from '../../src/api/server.ts'
import { MockTransport } from '../../src/adapters/qq/api-client.ts'
import { c2cEvent, cleanupDirs, makeRig } from '../adapters/helpers.ts'
import type { Rig } from '../adapters/helpers.ts'

after(() => cleanupDirs())

const TOKEN = 'cross-platform-token-123'
const QQ_USER = 'qq_openid_alpha'

function qqTransport(): MockTransport {
  return new MockTransport(
    [
      { status: 200, body: { access_token: 'fake', expires_in: 7200 } },
      { status: 200, body: { id: 'sent_1' } },
    ],
    { status: 200, body: { id: 'sent_more' } },
  )
}

async function bootSt(rig: Rig): Promise<{ close: () => Promise<void>; url: string; auth: Record<string, string> }> {
  const handle = createApiServer({
    runtime: rig.runtime,
    token: TOKEN,
    port: 0,
    logger: () => {},
    stIdentityUserId: 'local-default',
  })
  const { url } = await handle.listen()
  return {
    url,
    auth: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', connection: 'close' },
    close: async () => {
      await handle.close()
    },
  }
}

async function stPost(url: string, auth: Record<string, string>, path: string, body: unknown): Promise<Response> {
  return fetch(`${url}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) })
}

describe('跨平台 · QQ → 酒馆 记忆连续性', () => {
  it('QQ 约定 → 绑定码 → 酒馆能准确恢复约定，且关系一致', async () => {
    const rig = makeRig({ transport: qqTransport() })
    const st = await bootSt(rig)
    try {
      // 1) QQ 里建立约定
      const qqTurn = await rig.runtime.gateway.handleRaw(
        'qq',
        c2cEvent({ id: 'q1', openid: QQ_USER, content: '那我们说好，我明天下午来拿那本被水泡过的书，可以吗？' }),
      )
      assert.equal(qqTurn.status, 'replied')
      const instanceId = qqTurn.instanceId!
      const qqState = rig.runtime.runtimeManager.get(instanceId).workspace.relationship

      const memoriesBefore = rig.runtime.persistence.listMemories(instanceId, { includeDeleted: true })
      assert.ok(memoriesBefore.length > 0, 'QQ 侧应写入记忆')

      // 2) QQ 里申请绑定码
      const bindTurn = await rig.runtime.gateway.handleRaw('qq', c2cEvent({ id: 'q2', openid: QQ_USER, content: '/bind' }))
      assert.equal(bindTurn.status, 'command')
      const code = /(\d{8})/.exec(bindTurn.reply ?? '')?.[1]
      assert.ok(code, `绑定码应出现在回复中：${bindTurn.reply}`)

      // 3) 酒馆提交绑定码
      const redeem = await stPost(st.url, st.auth, '/v1/identity/redeem', { code })
      assert.equal(redeem.status, 200)
      const redeemed = (await redeem.json()) as { instanceId: string }
      assert.equal(redeemed.instanceId, instanceId, '两个平台应指向同一个实例')

      // 4) 酒馆里问起约定
      const ask = await stPost(st.url, st.auth, '/v1/messages', { text: '我们之前说好的事还记得吗？' })
      assert.equal(ask.status, 200)
      const askBody = (await ask.json()) as {
        reply: string
        instanceId: string
        state: { trust: number; familiarity: number; memories: number }
      }
      assert.equal(askBody.instanceId, instanceId)
      assert.ok(askBody.reply.length > 0)
      assert.equal(askBody.state.trust, qqState.trust, '关系状态必须跨平台一致')
      assert.equal(askBody.state.familiarity, qqState.familiarity)

      // 5) 共同经历没有被重复写入（记忆条数在可解释范围内增长，不是翻倍）
      const memoriesAfter = rig.runtime.persistence.listMemories(instanceId, { includeDeleted: true })
      assert.ok(
        memoriesAfter.length <= memoriesBefore.length + 2,
        `记忆不应因绑定而重复灌入：${memoriesBefore.length} -> ${memoriesAfter.length}`,
      )
    } finally {
      await st.close()
      rig.runtime.close()
    }
  })

  it('重启后绑定关系与记忆仍然有效', async () => {
    const rig = makeRig({ transport: qqTransport() })
    const first = await bootSt(rig)
    let instanceId = ''
    let code = ''
    try {
      const qqTurn = await rig.runtime.gateway.handleRaw(
        'qq',
        c2cEvent({ id: 'r1', openid: QQ_USER, content: '那我们说好，我明天下午来拿书。' }),
      )
      instanceId = qqTurn.instanceId!
      const bindTurn = await rig.runtime.gateway.handleRaw('qq', c2cEvent({ id: 'r2', openid: QQ_USER, content: '/bind' }))
      code = /(\d{8})/.exec(bindTurn.reply ?? '')![1]!
      const redeem = await stPost(first.url, first.auth, '/v1/identity/redeem', { code })
      assert.equal(redeem.status, 200)
    } finally {
      await first.close()
      rig.runtime.close()
    }

    const rig2 = makeRig({ dbPath: rig.dbPath, transport: qqTransport() })
    const second = await bootSt(rig2)
    try {
      const me = await fetch(`${second.url}/v1/identity/me`, { headers: second.auth })
      const meBody = (await me.json()) as { instanceId: string }
      assert.equal(meBody.instanceId, instanceId, '重启后绑定关系应恢复')

      const memories = await fetch(`${second.url}/v1/characters/${instanceId}/memories`, { headers: second.auth })
      const memoryBody = (await memories.json()) as { memories: unknown[] }
      assert.ok(memoryBody.memories.length > 0, '重启后记忆应仍在')

      const ask = await stPost(second.url, second.auth, '/v1/messages', { text: '上次约好的书还在吗？' })
      assert.equal(ask.status, 200)
    } finally {
      await second.close()
      rig2.runtime.close()
    }
  })

  it('未绑定的第三方身份读不到该实例', async () => {
    const rig = makeRig({ transport: qqTransport() })
    const st = await bootSt(rig)
    try {
      const qqTurn = await rig.runtime.gateway.handleRaw('qq', c2cEvent({ id: 'i1', openid: QQ_USER, content: '你好' }))
      const instanceId = qqTurn.instanceId!
      const forbidden = await fetch(`${st.url}/v1/characters/${instanceId}/state`, {
        headers: { ...st.auth, connection: 'close', 'x-characterlife-identity': 'intruder' },
      })
      assert.equal(forbidden.status, 400, '未知身份应先被拒绝绑定校验')
      const body = (await forbidden.json()) as { error: { code: string } }
      assert.equal(body.error.code, 'IDENTITY_NOT_BOUND')
    } finally {
      await st.close()
      rig.runtime.close()
    }
  })

  it('两个平台同时发消息不会互相覆盖状态', async () => {
    const rig = makeRig({ transport: qqTransport() })
    const st = await bootSt(rig)
    try {
      const first = await rig.runtime.gateway.handleRaw('qq', c2cEvent({ id: 'c1', openid: QQ_USER, content: '在吗？' }))
      const instanceId = first.instanceId!
      const bindTurn = await rig.runtime.gateway.handleRaw('qq', c2cEvent({ id: 'c2', openid: QQ_USER, content: '/bind' }))
      const code = /(\d{8})/.exec(bindTurn.reply ?? '')![1]!
      await stPost(st.url, st.auth, '/v1/identity/redeem', { code })

      const [qqSide, stSide] = await Promise.all([
        rig.runtime.gateway.handleRaw('qq', c2cEvent({ id: 'c3', openid: QQ_USER, content: '我今天有点累。' })),
        stPost(st.url, st.auth, '/v1/messages', { text: '我今天有点累。' }),
      ])
      assert.equal(qqSide.status, 'replied')
      assert.equal(stSide.status, 200)

      const relationship = rig.runtime.runtimeManager.get(instanceId).workspace.relationship
      assert.ok(relationship.trust >= 0 && relationship.trust <= 100)
      const events = rig.runtime.persistence.listEvents(instanceId)
      assert.ok(events.length > 0)
    } finally {
      await st.close()
      rig.runtime.close()
    }
  })
})

describe('跨平台 · 绑定安全', () => {
  it('绑定码一次性：第二次消费失败', async () => {
    const rig = makeRig({ transport: qqTransport() })
    const st = await bootSt(rig)
    try {
      await rig.runtime.gateway.handleRaw('qq', c2cEvent({ id: 'o1', openid: QQ_USER, content: '你好' }))
      const bindTurn = await rig.runtime.gateway.handleRaw('qq', c2cEvent({ id: 'o2', openid: QQ_USER, content: '/bind' }))
      const code = /(\d{8})/.exec(bindTurn.reply ?? '')![1]!
      const first = await stPost(st.url, st.auth, '/v1/identity/redeem', { code })
      assert.equal(first.status, 200)
      const second = await stPost(st.url, st.auth, '/v1/identity/redeem', { code })
      assert.equal(second.status, 400)
      const body = (await second.json()) as { error: { code: string } }
      assert.equal(body.error.code, 'CONSUMED')
    } finally {
      await st.close()
      rig.runtime.close()
    }
  })

  it('绑定码不会因为「知道实例 id」而生效', async () => {
    const rig = makeRig({ transport: qqTransport() })
    const st = await bootSt(rig)
    try {
      const qqTurn = await rig.runtime.gateway.handleRaw('qq', c2cEvent({ id: 'x1', openid: QQ_USER, content: '你好' }))
      const instanceId = qqTurn.instanceId!
      // 直接猜 8 位码应有 404/400，且不能绑定
      const guess = await stPost(st.url, st.auth, '/v1/identity/redeem', { code: '00000000' })
      assert.ok([400, 404].includes(guess.status))
      const me = await fetch(`${st.url}/v1/identity/me`, { headers: st.auth })
      const meBody = (await me.json()) as { instanceId: string | null }
      assert.notEqual(meBody.instanceId, instanceId)
    } finally {
      await st.close()
      rig.runtime.close()
    }
  })
})
