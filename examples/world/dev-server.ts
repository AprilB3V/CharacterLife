/**
 * CharacterLife × CL-World 联调入口（第一阶段 · 内存动作队列）
 *
 * 做四件事：
 *   1. 装配一个最小 runtime（默认 MockProvider，无需 API Key）；
 *   2. 打开世界交互（只允许 use / desk_01）；
 *   3. 起一个本地 HTTP API，并挂上 GET /v1/world/actions 与 POST /v1/world/events；
 *   4. 登记一个固定动作 use(desk_01)，把可直接粘贴的 curl 打在终端上。
 *
 * 已知限制（第一阶段刻意如此）：
 *   - 动作队列只在内存：进程重启后动作与去重键全部丢失；
 *   - 世界事件**不会**变成记忆、状态或聊天消息（只更新动作记录）；
 *   - 还没有和模型意图相连：动作只来自本脚本或 dev seed 接口。
 *
 * 运行：
 *   npm run world:dev
 *   CLWORLD_PORT=8792 npm run world:dev
 */

import { assembleRuntime } from '../../src/api/runtime-factory.ts'
import { createApiServer } from '../../src/api/server.ts'
import { WORLD_DEV_ACTION } from '../../src/api/world-routes.ts'

const WORLD_ID = process.env.CLWORLD_WORLD_IDS?.split(',')[0]?.trim() || 'cl-world-main'
const INSTANCE_KEY = process.env.CLWORLD_DEV_INSTANCE_KEY ?? 'cl-world-dev'

const PORT = Number(process.env.CLWORLD_PORT ?? process.env.CHARACTERLIFE_PORT ?? 8792)
const HOST = process.env.CHARACTERLIFE_HOST ?? '127.0.0.1'

// 联调用固定凭据：只在本机回环地址上生效；生产必须换成随机值。
const CHAT_TOKEN = process.env.CHARACTERLIFE_API_TOKEN ?? 'local-dev-token-change-me'
const WORLD_TOKEN = process.env.CLWORLD_TOKEN ?? 'clworld-dev-token-0123456789abcdef'

const DB_PATH = process.env.CHARACTERLIFE_DB ?? 'examples/.data/world-dev.db'

// 联调默认给 10 分钟窗口：Codex 侧轮询/手动 curl 都不至于把动作放过期。
const ACTION_TTL_MS = Number(process.env.CLWORLD_ACTION_TTL_MS ?? 10 * 60 * 1000)
const LEASE_TTL_MS = Number(process.env.CLWORLD_LEASE_TTL_MS ?? 30 * 1000)

function line(text = ''): void {
  console.log(text)
}

async function main(): Promise<void> {
  const runtime = assembleRuntime({
    dbPath: DB_PATH,
    worldId: WORLD_ID,
    world: {
      enabled: true,
      worldIds: [WORLD_ID],
      allowedVerbs: ['use'],
      allowedTargets: ['desk_01'],
      actionTtlMs: ACTION_TTL_MS,
      leaseTtlMs: LEASE_TTL_MS,
      maxAttempts: 2,
    },
  })

  if (!runtime.world) {
    throw new Error('世界交互未能启用：检查 WorldRuntimeConfig')
  }

  // 联调实例由服务端创建；客户端永远拿不到「自己指定 instanceId」的入口。
  const resolved = runtime.identityService.resolveOrCreate('world', INSTANCE_KEY)
  const instanceId = resolved.instance.id

  const api = createApiServer({
    runtime,
    host: HOST,
    port: PORT,
    token: CHAT_TOKEN,
    logger: () => {},
    world: { token: WORLD_TOKEN, devMode: true },
  })
  const { url } = await api.listen()

  line('')
  line('CharacterLife × CL-World 联调入口（第一阶段 · 内存动作队列 · 重启即丢失）')
  line('─'.repeat(72))
  line(`  HTTP        ${url}`)
  line(`  worldId     ${WORLD_ID}`)
  line(`  instanceId  ${instanceId}`)
  line(`  世界 Token   ${WORLD_TOKEN}`)
  line(`  聊天 Token   ${CHAT_TOKEN}（仅供其它既有接口使用，**不能**调世界接口）`)
  line(`  数据库       ${DB_PATH}（只存角色状态；动作队列不在库里）`)
  line('')

  // 开机登记一个固定动作，保证 Codex 一起来就能拉到东西。
  if (process.env.CLWORLD_DEV_AUTOSEED !== 'false') {
    const seeded = runtime.world.admit({
      worldId: WORLD_ID,
      instanceId,
      spec: {
        verb: WORLD_DEV_ACTION.verb,
        target: WORLD_DEV_ACTION.target,
        args: { ...WORLD_DEV_ACTION.args },
        reason: WORLD_DEV_ACTION.reason,
        evidence: [...WORLD_DEV_ACTION.evidence],
        expectation: WORLD_DEV_ACTION.expectation,
        turnId: null,
      },
    })
    if (seeded.ok) {
      line(`已登记固定动作：${seeded.action.actionId}  ${seeded.action.verb}(${seeded.action.target})  ` +
        `status=${seeded.action.status}  narration=${seeded.action.narration}`)
      line(`  过期时刻（模拟时间）: ${seeded.action.expiresAtSim}（TTL ${ACTION_TTL_MS}ms）`)
    } else {
      line(`自动登记失败：${seeded.code} ${seeded.reasons.join('；')}`)
    }
    line('')
  }

  line('① 世界领取待执行动作（领取即进入 dispatched）')
  line(`  curl -s -H "Authorization: Bearer ${WORLD_TOKEN}" \\`)
  line(`    "${url}/v1/world/actions?worldId=${WORLD_ID}&limit=4"`)
  line('')
  line('② 世界上报执行结果（action_result，结果只能是 succeeded / failed / rejected）')
  line(`  curl -s -X POST "${url}/v1/world/events" \\`)
  line(`    -H "Authorization: Bearer ${WORLD_TOKEN}" -H "Content-Type: application/json" \\`)
  line(`    -d '{"worldId":"${WORLD_ID}","events":[{"eventId":"evt-001","instanceId":"${instanceId}",` +
    `"actionId":"wa_001","kind":"action_result","result":"succeeded","atWorldTimeMs":128900,` +
    `"summary":"角色在书桌前停留约 2 秒","facts":[{"key":"desk_01.used","value":true}],"code":null}]}'`)
  line('')
  line('  注意（Windows）：上面的单引号 JSON 在 PowerShell/cmd 里会被拆参数，改用文件更稳：')
  line('    curl -s -X POST "' + url + '/v1/world/events" \\')
  line(`      -H "Authorization: Bearer ${WORLD_TOKEN}" -H "Content-Type: application/json" \\`)
  line('      --data-binary "@event.json"')
  line('')
  line('③ 再登记一个动作（仅 dev 模式；不需要重启）')
  line(`  curl -s -X POST -H "Authorization: Bearer ${WORLD_TOKEN}" \\`)
  line(`    "${url}/v1/world/dev/seed?worldId=${WORLD_ID}"`)
  line('')
  line('④ 反例：用聊天 Token 调世界接口 → 401 UNAUTHORIZED')
  line('')
  line('Ctrl+C 退出。动作队列不落库，重启后 actionId 会从 wa_001 重新开始。')
  line('')

  const shutdown = async (): Promise<void> => {
    line('\n正在关闭…')
    await api.close()
    runtime.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

void main().catch((err: unknown) => {
  console.error('启动失败：', err instanceof Error ? err.message : err)
  process.exit(1)
})
