/**
 * V0.3 端到端验收（真实 HTTP，两套凭据）
 *
 * 一条完整的验收链路：
 *   用户聊天 → 模型产出动作 → 世界（用 world token）领取 → 回执成功
 *   → 下一轮模型上下文把这条写成「已确认成功」。
 *
 * 另外验证：用聊天 token 调世界接口会 401（两套凭据不通用）。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { assembleRuntime } from '../../src/api/runtime-factory.ts'
import { createApiServer } from '../../src/api/server.ts'
import { MockProvider } from '../../src/conversation/providers/mock.ts'
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/types.ts'

const WORLD = 'cl-world-e2e'
const CHAT_TOKEN = 'e2e-chat-token-0123456789'
const WORLD_TOKEN = 'e2e-world-token-0123456789abcdef'

class RecordingProvider implements LLMProvider {
  readonly name = 'mock-recording'
  readonly model: string
  #inner: LLMProvider
  lastSystem = ''
  constructor(inner: LLMProvider) {
    this.#inner = inner
    this.model = inner.model
  }
  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.lastSystem = request.system
    return this.#inner.complete(request)
  }
}

async function boot() {
  const provider = new RecordingProvider(new MockProvider({ mode: 'in-character' }))
  const runtime = assembleRuntime({
    dbPath: ':memory:',
    worldId: WORLD,
    provider,
    world: { enabled: true, worldIds: [WORLD], allowedVerbs: ['use'], allowedTargets: ['desk_01'] },
  })
  const api = createApiServer({
    runtime,
    port: 0,
    token: CHAT_TOKEN,
    logger: () => {},
    world: { token: WORLD_TOKEN },
  })
  const { url } = await api.listen()
  const call = async (
    path: string,
    init: { token: string; method?: string; body?: unknown },
  ): Promise<{ status: number; body: any }> => {
    const response = await fetch(`${url}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        connection: 'close',
        'content-type': 'application/json',
        authorization: `Bearer ${init.token}`,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    return { status: response.status, body: await response.json() }
  }
  return { runtime, api, provider, url, call, close: async () => { await api.close(); runtime.close() } }
}

describe('World E2E · 聊天 → 动作 → 执行 → 认知', () => {
  it('完整闭环：用户请求触发动作，Godot 领取并回执，下一轮只承认已确认结果', async () => {
    const ctx = await boot()
    try {
      // 1) 用户请求
      const first = await ctx.call('/v1/messages', {
        token: CHAT_TOKEN,
        method: 'POST',
        body: { text: '你能帮我去桌子旁看看吗？' },
      })
      assert.equal(first.status, 200)
      assert.equal(typeof first.body.reply, 'string')
      const instanceId = first.body.instanceId as string
      assert.ok(instanceId.length > 0)

      // 2) 世界领取（此时才真正"下发"给 Godot）
      const leased = await ctx.call(`/v1/world/actions?worldId=${WORLD}`, { token: WORLD_TOKEN })
      assert.equal(leased.status, 200)
      assert.equal(leased.body.actions.length, 1)
      const action = leased.body.actions[0]
      assert.equal(action.verb, 'use')
      assert.equal(action.target, 'desk_01')
      assert.equal(action.instanceId, instanceId)
      assert.equal(action.status, 'dispatched')

      // 3) 回执成功
      const reported = await ctx.call('/v1/world/events', {
        token: WORLD_TOKEN,
        method: 'POST',
        body: {
          worldId: WORLD,
          events: [
            {
              eventId: 'e2e-evt-1',
              instanceId,
              actionId: action.actionId,
              kind: 'action_result',
              result: 'succeeded',
              atWorldTimeMs: 128_900,
              summary: '角色在书桌前停留约 2 秒',
              facts: [{ key: 'desk_01.used', value: true }],
              code: null,
            },
          ],
        },
      })
      assert.equal(reported.status, 200)
      assert.deepEqual(reported.body.accepted, ['e2e-evt-1'])

      // 4) 下一轮：模型上下文里出现"已确认成功"，且动作不再是未确认
      await ctx.call('/v1/messages', {
        token: CHAT_TOKEN,
        method: 'POST',
        body: { text: '刚才那件事怎么样了？' },
      })
      const system = ctx.provider.lastSystem
      assert.match(system, /已确认的世界结果/)
      assert.match(system, /use\(desk_01\) 成功（世界时间 128900）/)
      assert.ok(!system.includes('尚未确认的动作'), '已结算的动作不应再出现在未确认里')
      assert.ok(!system.includes('角色在书桌前停留约 2 秒'), '世界原文不得进入系统块')
    } finally {
      await ctx.close()
    }
  })

  it('聊天 token 不能领取世界动作，也不能上报回执', async () => {
    const ctx = await boot()
    try {
      const lease = await ctx.call(`/v1/world/actions?worldId=${WORLD}`, { token: CHAT_TOKEN })
      assert.equal(lease.status, 401)

      const report = await ctx.call('/v1/world/events', {
        token: CHAT_TOKEN,
        method: 'POST',
        body: { worldId: WORLD, events: [] },
      })
      assert.equal(report.status, 401)
    } finally {
      await ctx.close()
    }
  })

  it('Godot 离线：动作停在未确认，且不会产生世界事实记忆', async () => {
    const ctx = await boot()
    try {
      const first = await ctx.call('/v1/messages', {
        token: CHAT_TOKEN,
        method: 'POST',
        body: { text: '去桌子旁看看' },
      })
      const instanceId = first.body.instanceId as string
      assert.equal(ctx.runtime.world!.list({ instanceId }).length, 1)

      // 不领取、不回执，直接进入下一轮
      await ctx.call('/v1/messages', {
        token: CHAT_TOKEN,
        method: 'POST',
        body: { text: '辛苦了。' },
      })
      const system = ctx.provider.lastSystem
      assert.match(system, /尚未确认的动作/)
      assert.ok(!system.includes('已确认的世界结果'))
      assert.ok(!system.includes('成功'))

      const rt = ctx.runtime.runtimeManager.get(instanceId)
      assert.equal(rt.workspace.memory.list({ tags: ['world'] }).length, 0)
    } finally {
      await ctx.close()
    }
  })
})
