/**
 * 世界交互闭环演示（离线 · 零成本 · 无外部进程）
 *
 * 这个脚本**扮演 CL-World**：领取动作 → 假执行 → 上报结果，
 * 全部通过真实 HTTP 走一遍，用来验证第一阶段闭环确实通了。
 *
 * 运行：npm run world:demo
 */

import { assembleRuntime } from '../../src/api/runtime-factory.ts'
import { createApiServer } from '../../src/api/server.ts'

const WORLD_ID = 'cl-world-demo'
const CHAT_TOKEN = 'demo-chat-token-12345678'
const WORLD_TOKEN = 'demo-world-token-0123456789abcdef'

function head(title: string): void {
  console.log('')
  console.log(`── ${title} ${'─'.repeat(Math.max(0, 66 - title.length))}`)
}

async function main(): Promise<void> {
  const runtime = assembleRuntime({
    dbPath: ':memory:',
    worldId: WORLD_ID,
    world: { enabled: true, worldIds: [WORLD_ID], allowedVerbs: ['use'], allowedTargets: ['desk_01'] },
  })
  if (!runtime.world) throw new Error('世界交互未能启用')

  const instanceId = runtime.identityService.resolveOrCreate('world', 'demo-instance').instance.id
  const api = createApiServer({
    runtime,
    port: 0,
    token: CHAT_TOKEN,
    logger: () => {},
    world: { token: WORLD_TOKEN },
  })
  const { url } = await api.listen()
  const worldCall = (path: string, init: RequestInit = {}): Promise<Response> =>
    fetch(`${url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${WORLD_TOKEN}`,
        'content-type': 'application/json',
        connection: 'close',
        ...(init.headers ?? {}),
      },
    })

  head('1. 登记固定动作 use(desk_01)')
  const admitted = runtime.world.admit({
    worldId: WORLD_ID,
    instanceId,
    spec: {
      verb: 'use',
      target: 'desk_01',
      args: { seconds: 2 },
      reason: '演示：走到书桌前并使用它',
      evidence: [],
      expectation: '角色在书桌前停留',
      turnId: null,
    },
  })
  if (!admitted.ok) throw new Error(`准入失败：${admitted.code}`)
  console.log(JSON.stringify(admitted.action, null, 2))

  head('2. CL-World 领取动作  GET /v1/world/actions')
  const leased = await (await worldCall(`/v1/world/actions?worldId=${WORLD_ID}&limit=4`)).json()
  console.log(JSON.stringify(leased, null, 2))

  const actionId = (leased as { actions: Array<{ actionId: string }> }).actions[0]?.actionId
  if (!actionId) throw new Error('没有领到动作')

  head('3. CL-World 执行并上报结果  POST /v1/world/events')
  const event = {
    eventId: 'evt_demo_001',
    instanceId,
    actionId,
    kind: 'action_result',
    result: 'succeeded',
    atWorldTimeMs: 128_900,
    summary: '角色在书桌前停留约 2 秒，桌面上的纸被碰歪了一点',
    facts: [{ key: 'desk_01.used', value: true }],
    code: null,
  }
  const reported = await (await worldCall('/v1/world/events', {
    method: 'POST',
    body: JSON.stringify({ worldId: WORLD_ID, events: [event] }),
  })).json()
  console.log(JSON.stringify(reported, null, 2))

  head('4. 同一 eventId 重投 → duplicates（幂等）')
  const replay = await (await worldCall('/v1/world/events', {
    method: 'POST',
    body: JSON.stringify({ worldId: WORLD_ID, events: [event] }),
  })).json()
  console.log(JSON.stringify(replay, null, 2))

  head('5. 再领取 → 没有待执行动作')
  const empty = await (await worldCall(`/v1/world/actions?worldId=${WORLD_ID}`)).json()
  console.log(JSON.stringify(empty, null, 2))

  head('6. 用聊天 Token 调世界接口 → 401（两套凭据互不通用）')
  const wrong = await fetch(`${url}/v1/world/actions?worldId=${WORLD_ID}`, {
    headers: { authorization: `Bearer ${CHAT_TOKEN}`, connection: 'close' },
  })
  console.log(`HTTP ${wrong.status} ${JSON.stringify(await wrong.json())}`)

  head('7. 世界事件没有变成记忆或状态（角色状态未被改动）')
  const rt = runtime.runtimeManager.get(instanceId)
  console.log(`world 标记的记忆条数：${rt.workspace.memory.list({ tags: ['world'] }).length}`)
  console.log(`动态状态（未变）：${JSON.stringify(rt.workspace.dynamicState.activity)}`)

  await api.close()
  runtime.close()
  head('闭环完成')
}

void main().catch((err: unknown) => {
  console.error('演示失败：', err instanceof Error ? err.stack : err)
  process.exit(1)
})
