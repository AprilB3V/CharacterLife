/**
 * 世界交互 HTTP 集成测试（第一阶段）。
 *
 * 覆盖：
 * - 独立 world token：聊天 token 不能调世界接口，world token 不能调聊天接口；
 * - GET /v1/world/actions 领取固定动作 use(desk_01)；
 * - POST /v1/world/events 三态结果、eventId/actionId 双层去重、逐条部分成功；
 * - worldId / instanceId 服务端绑定（请求体伪造无效）；
 * - 世界事件不产生记忆、状态、时间线或持久层事件；
 * - 未启用世界时路由不存在；启用但缺 token / token 与聊天相同时拒绝启动。
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { assembleRuntime } from '../../src/api/runtime-factory.ts'
import type { RuntimeBundle } from '../../src/api/runtime-factory.ts'
import { createApiServer } from '../../src/api/server.ts'
import { WORLD_DEV_ACTION } from '../../src/api/world-routes.ts'
import { ManualClock } from '../../src/util/clock.ts'

const WORLD = 'cl-world-test'
const CHAT_TOKEN = 'chat-token-0123456789'
const WORLD_TOKEN = 'world-token-0123456789abcdef'

const DATA = join(process.cwd(), 'tests', '.data', 'world')
const dirs: string[] = []

after(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响结论 */
    }
  }
})

function freshDb(name: string): string {
  const dir = join(DATA, `${name}_${Date.now().toString(36)}`)
  mkdirSync(dir, { recursive: true })
  dirs.push(dir)
  return join(dir, 'world.db')
}

function makeRuntime(opts: { dbPath?: string; world?: boolean } = {}): RuntimeBundle {
  return assembleRuntime({
    dbPath: opts.dbPath ?? ':memory:',
    worldId: WORLD,
    clock: new ManualClock(0),
    world:
      opts.world === false
        ? undefined
        : { enabled: true, worldIds: [WORLD], allowedVerbs: ['use'], allowedTargets: ['desk_01'] },
  })
}

interface Ctx {
  runtime: RuntimeBundle
  instanceId: string
  url: string
  request: (path: string, init?: { token?: string | null; method?: string; body?: unknown }) => Promise<Response>
  close: () => Promise<void>
}

/**
 * 在本地起一个可用的 HTTP 服务。
 *
 * `port: 0` 由系统分配，但 undici 有一份「禁止请求的端口」名单（bad port），
 * 偶尔会撞上，导致 fetch 直接抛错而不是连不上。这里探测一次 /healthz，
 * 撞上就换一个端口重来 —— 这是测试装置的稳健性，与产品行为无关。
 */
async function listenOnFreePort(
  make: () => ReturnType<typeof createApiServer>,
): Promise<{ handle: ReturnType<typeof createApiServer>; url: string }> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const handle = make()
    const { url } = await handle.listen()
    try {
      await fetch(`${url}/healthz`, { headers: { connection: 'close' } })
      return { handle, url }
    } catch {
      await handle.close()
    }
  }
  throw new Error('无法获得一个可用的本地端口（连续命中 undici 禁用端口）')
}

async function boot(opts: { dbPath?: string; world?: boolean; devMode?: boolean } = {}): Promise<Ctx> {
  const runtime = makeRuntime(opts)
  const instanceId = runtime.identityService.resolveOrCreate('world', 'cl-world-instance').instance.id
  const { handle: api, url } = await listenOnFreePort(() =>
    createApiServer({
      runtime,
      port: 0,
      token: CHAT_TOKEN,
      logger: () => {},
      ...(runtime.world ? { world: { token: WORLD_TOKEN, devMode: opts.devMode === true } } : {}),
    }),
  )
  async function request(
    path: string,
    init: { token?: string | null; method?: string; body?: unknown } = {},
  ): Promise<Response> {
    const token = init.token === undefined ? WORLD_TOKEN : init.token
    return fetch(`${url}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        connection: 'close',
        'content-type': 'application/json',
        ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
  }
  return {
    runtime,
    instanceId,
    url,
    request,
    close: async () => {
      await api.close()
      runtime.close()
    },
  }
}

function eventFor(
  instanceId: string,
  actionId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    eventId: 'evt-001',
    instanceId,
    actionId,
    kind: 'action_result',
    result: 'succeeded',
    atWorldTimeMs: 128_900,
    summary: '角色在书桌前停留约 2 秒',
    facts: [{ key: 'desk_01.used', value: true }],
    code: null,
    ...overrides,
  }
}

describe('World HTTP · 鉴权隔离', () => {
  it('世界接口只认 world token：缺失/错误/聊天 token 全部 401', async () => {
    const ctx = await boot()
    try {
      const path = `/v1/world/actions?worldId=${WORLD}`
      assert.equal((await ctx.request(path, { token: null })).status, 401)
      assert.equal((await ctx.request(path, { token: 'obviously-wrong-token' })).status, 401)
      assert.equal((await ctx.request(path, { token: CHAT_TOKEN })).status, 401, '聊天 token 不得调用世界接口')
    } finally {
      await ctx.close()
    }
  })

  it('world token 不能调用聊天接口', async () => {
    const ctx = await boot()
    try {
      assert.equal((await ctx.request('/v1/identity/me')).status, 401)
      assert.equal(
        (await ctx.request('/v1/messages', { method: 'POST', body: { text: '你好' } })).status,
        401,
      )
    } finally {
      await ctx.close()
    }
  })

  it('未授权的 worldId 返回 403', async () => {
    const ctx = await boot()
    try {
      const res = await ctx.request('/v1/world/actions?worldId=evil-world')
      assert.equal(res.status, 403)
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'WORLD_MISMATCH')
    } finally {
      await ctx.close()
    }
  })
})

describe('World HTTP · 闭环', () => {
  it('dev seed 产生固定动作 use(desk_01)，instanceId 由服务端绑定', async () => {
    const ctx = await boot({ devMode: true })
    try {
      const res = await ctx.request(`/v1/world/dev/seed?worldId=${WORLD}`, {
        method: 'POST',
        // 伪造 instanceId：必须被忽略
        body: { instanceId: 'inst_forged' },
      })
      assert.equal(res.status, 200)
      const payload = (await res.json()) as {
        instanceId: string
        action: { actionId: string; verb: string; target: string; status: string; narration: string }
      }
      assert.equal(payload.instanceId, ctx.instanceId, 'instanceId 必须来自服务端解析')
      assert.equal(payload.action.verb, WORLD_DEV_ACTION.verb)
      assert.equal(payload.action.target, WORLD_DEV_ACTION.target)
      assert.equal(payload.action.status, 'pending')
      assert.equal(payload.action.narration, 'intent')
    } finally {
      await ctx.close()
    }
  })

  it('GET actions 领取后进入 dispatched，重复领取为空', async () => {
    const ctx = await boot({ devMode: true })
    try {
      await ctx.request(`/v1/world/dev/seed?worldId=${WORLD}`, { method: 'POST' })

      const first = (await (await ctx.request(`/v1/world/actions?worldId=${WORLD}`)).json()) as {
        worldId: string
        actions: Array<{ actionId: string; status: string; narration: string; verb: string; target: string }>
        counts: Record<string, number>
      }
      assert.equal(first.actions.length, 1)
      assert.equal(first.actions[0]!.status, 'dispatched')
      assert.equal(first.actions[0]!.narration, 'uncertain')
      assert.equal(first.actions[0]!.verb, 'use')
      assert.equal(first.actions[0]!.target, 'desk_01')
      assert.equal(first.counts.dispatched, 1)

      const second = (await (await ctx.request(`/v1/world/actions?worldId=${WORLD}`)).json()) as {
        actions: unknown[]
      }
      assert.equal(second.actions.length, 0, '租约期内不可重复领取')
    } finally {
      await ctx.close()
    }
  })

  for (const result of ['succeeded', 'failed', 'rejected'] as const) {
    it(`POST events result=${result} 被接受并结算动作`, async () => {
      const ctx = await boot({ devMode: true })
      try {
        const seed = (await (await ctx.request(`/v1/world/dev/seed?worldId=${WORLD}`, { method: 'POST' })).json()) as {
          action: { actionId: string }
        }
        const actionId = seed.action.actionId
        await ctx.request(`/v1/world/actions?worldId=${WORLD}`) // 领取（dispatched）

        const res = await ctx.request('/v1/world/events', {
          method: 'POST',
          body: { worldId: WORLD, events: [eventFor(ctx.instanceId, actionId, { result })] },
        })
        assert.equal(res.status, 200)
        const payload = (await res.json()) as {
          accepted: string[]
          rejected: unknown[]
          applied: { actionsUpdated: number }
          counts: Record<string, number>
        }
        assert.deepEqual(payload.accepted, ['evt-001'])
        assert.equal(payload.rejected.length, 0)
        assert.equal(payload.applied.actionsUpdated, 1)
        assert.equal(payload.counts[result], 1)
      } finally {
        await ctx.close()
      }
    })
  }

  it('同一 eventId 重投 → duplicates；同动作换 eventId → ACTION_ALREADY_SETTLED', async () => {
    const ctx = await boot({ devMode: true })
    try {
      const seed = (await (await ctx.request(`/v1/world/dev/seed?worldId=${WORLD}`, { method: 'POST' })).json()) as {
        action: { actionId: string }
      }
      const actionId = seed.action.actionId

      const first = (await (await ctx.request('/v1/world/events', {
        method: 'POST',
        body: { worldId: WORLD, events: [eventFor(ctx.instanceId, actionId)] },
      })).json()) as { accepted: string[] }

      const replay = (await (await ctx.request('/v1/world/events', {
        method: 'POST',
        body: { worldId: WORLD, events: [eventFor(ctx.instanceId, actionId)] },
      })).json()) as { accepted: string[]; duplicates: string[] }

      assert.deepEqual(first.accepted, ['evt-001'])
      assert.deepEqual(replay.accepted, [])
      assert.deepEqual(replay.duplicates, ['evt-001'])

      const conflict = (await (await ctx.request('/v1/world/events', {
        method: 'POST',
        body: { worldId: WORLD, events: [eventFor(ctx.instanceId, actionId, { eventId: 'evt-002', result: 'failed' })] },
      })).json()) as { rejected: Array<{ code: string }> }
      assert.equal(conflict.rejected[0]!.code, 'ACTION_ALREADY_SETTLED')
    } finally {
      await ctx.close()
    }
  })

  it('未知动作与实例不匹配逐条拒绝，HTTP 仍为 200（部分成功）', async () => {
    const ctx = await boot({ devMode: true })
    try {
      const seed = (await (await ctx.request(`/v1/world/dev/seed?worldId=${WORLD}`, { method: 'POST' })).json()) as {
        action: { actionId: string }
      }
      const res = await ctx.request('/v1/world/events', {
        method: 'POST',
        body: {
          worldId: WORLD,
          events: [
            eventFor(ctx.instanceId, seed.action.actionId, { eventId: 'evt-ok' }),
            eventFor(ctx.instanceId, 'wa_missing', { eventId: 'evt-missing' }),
            eventFor('inst_other', seed.action.actionId, { eventId: 'evt-wrong-instance' }),
          ],
        },
      })
      assert.equal(res.status, 200)
      const payload = (await res.json()) as {
        accepted: string[]
        rejected: Array<{ eventId: string; code: string }>
      }
      assert.deepEqual(payload.accepted, ['evt-ok'])
      assert.equal(payload.rejected.length, 2)
      assert.equal(payload.rejected[0]!.code, 'UNKNOWN_ACTION')
      assert.equal(payload.rejected[1]!.code, 'UNKNOWN_INSTANCE')
    } finally {
      await ctx.close()
    }
  })

  it('请求体 worldId 缺失/为空 → 400；批量为空 → 400', async () => {
    const ctx = await boot({ devMode: true })
    try {
      assert.equal(
        (await ctx.request('/v1/world/events', { method: 'POST', body: { events: [] } })).status,
        400,
      )
      assert.equal(
        (await ctx.request('/v1/world/events', {
          method: 'POST',
          body: { worldId: WORLD, events: [] },
        })).status,
        400,
      )
    } finally {
      await ctx.close()
    }
  })
})

describe('World HTTP · 世界事件不污染角色状态', () => {
  it('回执后记忆 / 动态状态 / 时间线 / 持久层事件均无变化', async () => {
    const ctx = await boot({ devMode: true })
    try {
      const rt = ctx.runtime.runtimeManager.get(ctx.instanceId)
      const before = {
        memories: rt.workspace.memory.list().length,
        dynamic: JSON.stringify(rt.workspace.dynamicState),
        timeline: rt.workspace.timeline.size,
        persistedEvents: ctx.runtime.persistence.listEvents(ctx.instanceId).length,
        proposalsApplied: rt.workspace.audit.count('proposal_applied'),
      }

      const seed = (await (await ctx.request(`/v1/world/dev/seed?worldId=${WORLD}`, { method: 'POST' })).json()) as {
        action: { actionId: string }
      }
      await ctx.request('/v1/world/events', {
        method: 'POST',
        body: { worldId: WORLD, events: [eventFor(ctx.instanceId, seed.action.actionId)] },
      })

      assert.equal(rt.workspace.memory.list({ tags: ['world'] }).length, 0, '不得产生世界事实记忆')
      assert.equal(rt.workspace.memory.list().length, before.memories)
      assert.equal(JSON.stringify(rt.workspace.dynamicState), before.dynamic)
      assert.equal(rt.workspace.timeline.size, before.timeline)
      assert.equal(ctx.runtime.persistence.listEvents(ctx.instanceId).length, before.persistedEvents)
      assert.equal(rt.workspace.audit.count('proposal_applied'), before.proposalsApplied)
    } finally {
      await ctx.close()
    }
  })
})

describe('World HTTP · 启动与关闭', () => {
  it('未启用世界时 /v1/world/* 返回 404 WORLD_DISABLED', async () => {
    const ctx = await boot({ world: false })
    try {
      const res = await ctx.request(`/v1/world/actions?worldId=${WORLD}`)
      assert.equal(res.status, 404)
      assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'WORLD_DISABLED')
    } finally {
      await ctx.close()
    }
  })

  it('dev seed 在 devMode=false 时不可用', async () => {
    const ctx = await boot({ devMode: false })
    try {
      const res = await ctx.request(`/v1/world/dev/seed?worldId=${WORLD}`, { method: 'POST' })
      assert.equal(res.status, 404)
    } finally {
      await ctx.close()
    }
  })

  it('启用世界但缺 world token → 拒绝启动', () => {
    const runtime = makeRuntime()
    try {
      assert.throws(
        () => createApiServer({ runtime, port: 0, token: CHAT_TOKEN, logger: () => {} }),
        /world token/,
      )
    } finally {
      runtime.close()
    }
  })

  it('world token 与聊天 token 相同 → 拒绝启动', () => {
    const runtime = makeRuntime()
    try {
      assert.throws(
        () =>
          createApiServer({
            runtime,
            port: 0,
            token: CHAT_TOKEN,
            logger: () => {},
            world: { token: CHAT_TOKEN },
          }),
        /不得与任何聊天 API Token 相同/,
      )
    } finally {
      runtime.close()
    }
  })

  it('动作队列不落库：同一数据库重启后队列为空', async () => {
    const dbPath = freshDb('restart')
    const first = await boot({ dbPath, devMode: true })
    try {
      await first.request(`/v1/world/dev/seed?worldId=${WORLD}`, { method: 'POST' })
      assert.equal(first.runtime.world!.list().length, 1)
    } finally {
      await first.close()
    }

    const second = await boot({ dbPath, devMode: true })
    try {
      assert.equal(second.runtime.world!.list().length, 0, '内存队列，重启即丢失')
      const res = (await (await second.request(`/v1/world/actions?worldId=${WORLD}`)).json()) as {
        actions: unknown[]
      }
      assert.equal(res.actions.length, 0)
      // 实例本身仍在（角色状态持久化，动作队列不持久化）
      assert.ok(second.runtime.persistence.getInstance(second.instanceId))
    } finally {
      await second.close()
    }
  })
})
