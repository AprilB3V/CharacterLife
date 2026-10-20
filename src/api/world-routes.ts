/**
 * 世界交互 HTTP 路由（第一阶段）。
 *
 * 刻意独立于平台适配器：这里只做「鉴权 → 校验 → 调 WorldService → 返回 JSON」，
 * 不引入 `PlatformAdapter`、不产生 `NormalizedMessage`、不触碰聊天链路。
 *
 * 鉴权用**独立的 world token**：
 * - 与 `CHARACTERLIFE_API_TOKEN` 互不通用（服务端启动时还会拒绝两者相同）；
 * - 常量时间比较，只比哈希，不在日志里出现明文。
 *
 * 两条必需接口：
 *   GET  /v1/world/actions   世界领取待执行动作（领取即进入 dispatched）
 *   POST /v1/world/events    世界上报回执（逐条幂等，部分成功）
 * 一条受控开发入口（仅 devMode）：
 *   POST /v1/world/dev/seed  登记一个固定动作 use(desk_01)，用于联调
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WorldService } from '../world/service.ts'
import type { WorldActionStatus } from '../world/contracts.ts'
import { WORLD_LIMITS } from '../world/contracts.ts'

export interface WorldRouterOptions {
  service: WorldService
  /** 世界专属 Bearer Token（明文只在内存中） */
  token: string
  /** 打开受控开发入口（dev seed）；生产必须为 false */
  devMode: boolean
  /** 服务端权威的实例解析：worldId → 该世界下的某个实例 id（dev seed 用） */
  resolveInstance: (worldId: string) => string | null
  /** 复用 API Server 的请求体读取（含体积上限） */
  readBody: (req: IncomingMessage) => Promise<string>
  readJson: (raw: string) => Record<string, unknown>
  json: (res: ServerResponse, status: number, payload: unknown) => void
  /** 复用 API Server 的固定窗口限流 */
  checkRate: (key: string) => boolean
}

export interface WorldRouter {
  /** 仅用于限流分桶，不含明文 token */
  readonly tokenHash: string
  /** 返回 true 表示该请求已由世界路由处理（响应已写出） */
  handle(req: IncomingMessage, res: ServerResponse): Promise<boolean>
}

const BEARER_PREFIX = 'Bearer '

/** 联调用的固定动作：第一阶段只允许 use(desk_01)。 */
export const WORLD_DEV_ACTION = {
  verb: 'use',
  target: 'desk_01',
  args: { seconds: 2 },
  reason: '联调用固定动作：走到书桌前并使用它',
  evidence: [],
  expectation: '角色在书桌前停留，桌面上的东西被碰过',
  turnId: null,
} as const

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest()
}

function jsonError(
  json: WorldRouterOptions['json'],
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  json(res, status, { error: { message, type: 'invalid_request_error', code } })
}

function parseLimit(raw: string | null): number {
  if (raw === null || raw.length === 0) return WORLD_LIMITS.DEFAULT_LEASE_LIMIT
  const n = Number(raw)
  if (!Number.isFinite(n)) return WORLD_LIMITS.DEFAULT_LEASE_LIMIT
  const int = Math.floor(n)
  if (int < 1) return 1
  if (int > WORLD_LIMITS.MAX_LEASE_LIMIT) return WORLD_LIMITS.MAX_LEASE_LIMIT
  return int
}

function tally(actions: ReadonlyArray<{ status: WorldActionStatus }>): Record<WorldActionStatus, number> {
  const counts: Record<WorldActionStatus, number> = {
    pending: 0,
    dispatched: 0,
    succeeded: 0,
    failed: 0,
    rejected: 0,
    expired: 0,
  }
  for (const a of actions) counts[a.status] += 1
  return counts
}

export function createWorldRouter(opts: WorldRouterOptions): WorldRouter {
  const expected = sha256(opts.token)
  const tokenHash = expected.toString('hex')
  const { service, json, readBody, readJson, checkRate } = opts

  function authorized(req: IncomingMessage): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) return false
    const provided = header.slice(BEARER_PREFIX.length).trim()
    if (provided.length === 0) return false
    const digest = sha256(provided)
    return digest.length === expected.length && timingSafeEqual(digest, expected)
  }

  return {
    tokenHash,

    async handle(req, res): Promise<boolean> {
      const method = req.method ?? 'GET'
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const path = url.pathname

      if (!path.startsWith('/v1/world/')) return false

      if (!authorized(req)) {
        jsonError(json, res, 401, 'UNAUTHORIZED', '缺少或无效的世界 Token')
        return true
      }
      if (!checkRate(`world:${tokenHash}`)) {
        jsonError(json, res, 429, 'RATE_LIMITED', '请求过于频繁')
        return true
      }

      /* ------------------------- 领取待执行动作 ------------------------- */
      if (method === 'GET' && path === '/v1/world/actions') {
        const worldId = url.searchParams.get('worldId')
        if (worldId === null || worldId.length === 0) {
          jsonError(json, res, 400, 'INVALID_QUERY', 'worldId 必填')
          return true
        }
        if (!service.authorizesWorld(worldId)) {
          jsonError(json, res, 403, 'WORLD_MISMATCH', `worldId ${worldId} 未被本服务授权`)
          return true
        }
        const limit = parseLimit(url.searchParams.get('limit'))
        const actions = service.lease(worldId, limit)
        json(res, 200, {
          worldId,
          nowSim: service.nowSim(),
          actions,
          counts: tally(service.list({ worldId })),
          _persistent: false,
        })
        return true
      }

      /* --------------------------- 上报回执 ---------------------------- */
      if (method === 'POST' && path === '/v1/world/events') {
        const body = readJson(await readBody(req))
        const worldId = typeof body.worldId === 'string' ? body.worldId : ''
        if (worldId.length === 0) {
          jsonError(json, res, 400, 'INVALID_BODY', 'worldId 必填')
          return true
        }
        if (!service.authorizesWorld(worldId)) {
          jsonError(json, res, 403, 'WORLD_MISMATCH', `worldId ${worldId} 未被本服务授权`)
          return true
        }
        if (!Array.isArray(body.events)) {
          jsonError(json, res, 400, 'INVALID_BODY', 'events 必须是数组')
          return true
        }
        if (body.events.length === 0) {
          jsonError(json, res, 400, 'INVALID_BODY', 'events 不能为空')
          return true
        }
        if (body.events.length > WORLD_LIMITS.MAX_EVENTS_PER_BATCH) {
          jsonError(
            json,
            res,
            400,
            'BATCH_TOO_LARGE',
            `单批最多 ${WORLD_LIMITS.MAX_EVENTS_PER_BATCH} 条事件`,
          )
          return true
        }
        const result = service.ingest(worldId, body.events)
        json(res, 200, {
          worldId,
          nowSim: service.nowSim(),
          ...result,
          counts: tally(service.list({ worldId })),
        })
        return true
      }

      /* ----------------------- 受控开发入口（dev） ----------------------- */
      if (method === 'POST' && path === '/v1/world/dev/seed') {
        if (!opts.devMode) {
          jsonError(json, res, 404, 'NOT_FOUND', '未启用开发入口')
          return true
        }
        const worldId = url.searchParams.get('worldId') ?? service.worldIds[0] ?? ''
        if (worldId.length === 0) {
          jsonError(json, res, 400, 'INVALID_QUERY', '服务端未配置任何 worldId')
          return true
        }
        if (!service.authorizesWorld(worldId)) {
          jsonError(json, res, 403, 'WORLD_MISMATCH', `worldId ${worldId} 未被本服务授权`)
          return true
        }
        // 实例由服务端解析，**不接受请求体指定**
        const instanceId = opts.resolveInstance(worldId)
        if (instanceId === null) {
          jsonError(json, res, 409, 'NO_INSTANCE', `世界 ${worldId} 下没有任何角色实例`)
          return true
        }
        const admitted = service.admit({
          worldId,
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
        if (!admitted.ok) {
          json(res, 409, { error: { message: admitted.reasons.join('；'), type: 'invalid_request_error', code: admitted.code } })
          return true
        }
        json(res, 200, { worldId, instanceId, action: admitted.action, _persistent: false })
        return true
      }

      jsonError(json, res, 404, 'NOT_FOUND', `未知世界接口：${method} ${path}`)
      return true
    },
  }
}
