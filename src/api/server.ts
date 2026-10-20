/**
 * 本地 HTTP API（默认只监听 127.0.0.1）。
 *
 * 安全基线（任务书第七节）：
 * - Bearer Token 鉴权（常量时间比较），未配置 token 直接拒绝启动；
 * - 非回环地址必须显式 allowNonLoopback 才允许绑定；
 * - 请求体上限、按 token 限流、错误统一为 JSON；
 * - 日志只记方法/路径/状态/耗时，不记消息内容、不记 token；
 * - 外部请求无法修改人格或权限策略（引擎侧本来就不给这些能力）。
 *
 * 接口：
 *   GET    /healthz                      健康检查（无鉴权）
 *   GET    /v1/models                    OpenAI 模型列表
 *   POST   /v1/chat/completions          OpenAI Chat Completions（支持 stream）
 *   POST   /v1/messages                  原生消息接口
 *   POST   /v1/sessions                  新开会话（保留长期记忆）
 *   GET    /v1/characters/:id/state      公开状态
 *   GET    /v1/characters/:id/memories   个人记忆列表
 *   DELETE /v1/memories/:id              删除一条记忆
 *   GET    /v1/identity/me               当前平台身份
 *   POST   /v1/identity/bind-code        签发一次性绑定码
 *   POST   /v1/identity/redeem           用绑定码绑定当前身份
 *   DELETE /v1/identity/binding          解绑当前身份
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createHash } from 'node:crypto'
import type { RuntimeBundle } from './runtime-factory.ts'
import type { NormalizedMessage } from '../adapters/protocol.ts'
import { safeEqual } from '../adapters/qq/webhook.ts'
import {
  buildChatCompletionResponse,
  buildModelsResponse,
  buildSSEChunks,
  SillyTavernRequestError,
} from '../adapters/sillytavern/openai.ts'
import { OWNER_ACTOR } from '../policy/policy.ts'
import { createWorldRouter } from './world-routes.ts'
import type { WorldRouter } from './world-routes.ts'

export interface ApiCredential {
    token: string
    platformUserId: string
}

export interface ApiServerOptions {
  runtime: RuntimeBundle
    /** Local credential, scoped exclusively to stIdentityUserId. */
    token?: string
    /** Server-provisioned identity credentials; mutually exclusive with token. */
    credentials?: readonly ApiCredential[]
  host?: string
  port?: number
  /** 允许绑定非回环地址（默认 false；公网部署不在本次授权范围） */
  allowNonLoopback?: boolean
  /** SillyTavern 本地身份（默认 local-default） */
  stIdentityUserId?: string
  modelId?: string
  bodyLimitBytes?: number
  rateLimit?: { windowMs?: number; max?: number }
  logger?: (line: string) => void
  /**
   * 世界交互的独立凭据。
   *
   * 只有 `runtime.world` 非空时才需要；此时缺 token 会**拒绝启动**（fail closed）。
   * 该 token 与聊天 API token 必须不同，否则同样拒绝启动。
   */
  world?: {
    token: string
    /** 打开受控开发入口（dev seed）；生产必须为 false */
    devMode?: boolean
  }
}

export interface ApiServerHandle {
  server: Server
  listen(): Promise<{ host: string; port: number; url: string }>
  close(): Promise<void>
  readonly url: string | null
}

class HttpError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string, message: string) {
    super(message)
    this.status = status
    this.code = code
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

function headerValue(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.length > 0) return value[0] ?? null
  return null
}

export function createApiServer(opts: ApiServerOptions): ApiServerHandle {
  const host = opts.host ?? '127.0.0.1'
  if (!LOOPBACK.has(host) && !opts.allowNonLoopback) {
    throw new Error(`拒绝绑定非回环地址 ${host}：需要显式 allowNonLoopback=true（公网部署不在本次授权范围）`)
  }
    if (opts.token !== undefined && opts.credentials !== undefined) {
        throw new Error('token 与 credentials 不能同时配置')
    }
    const configuredCredentials = opts.credentials ?? (
        opts.token === undefined ? [] : [{ token: opts.token, platformUserId: opts.stIdentityUserId ?? 'local-default' }]
    )
    if (configuredCredentials.length === 0) {
        throw new Error('必须提供 API Token 或身份凭据列表')
    }
    // Snapshot the allowlist so caller mutations cannot change an authenticated scope.
    const credentials = configuredCredentials.map((credential) => {
        if (typeof credential.token !== 'string' || credential.token.trim() !== credential.token || credential.token.length < 8
            || typeof credential.platformUserId !== 'string' || !credential.platformUserId.trim()
            || credential.platformUserId.trim() !== credential.platformUserId) {
            throw new Error('凭据需要至少 8 位 Token 和非空身份')
        }
        return {
            tokenHash: createHash('sha256').update(credential.token).digest('hex'),
            platformUserId: credential.platformUserId,
        }
    })
    if (new Set(credentials.map((credential) => credential.tokenHash)).size !== credentials.length) {
        throw new Error('API Token 不得重复配置')
    }

  const { runtime } = opts
  const bodyLimit = opts.bodyLimitBytes ?? 256 * 1024
  const modelId = opts.modelId ?? 'characterlife/shen-zhiwei'
  const logger = opts.logger ?? ((line: string) => console.log(line))
  const windowMs = opts.rateLimit?.windowMs ?? 60_000
  const maxPerWindow = opts.rateLimit?.max ?? 120
  const buckets = new Map<string, { count: number; resetAt: number }>()
  let url: string | null = null


  const checkRate = (key: string): boolean => {
    const now = Date.now()
    const bucket = buckets.get(key)
    if (!bucket || now >= bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs })
      return true
    }
    if (bucket.count >= maxPerWindow) return false
    bucket.count++
    return true
  }

  // 世界交互凭据：与聊天凭据完全分离。
  // 启用世界但没给 token、或两个 token 相同，都在启动时直接失败（fail closed）。
  let worldRouter: WorldRouter | null = null
  if (runtime.world) {
    const worldToken = opts.world?.token
    if (typeof worldToken !== 'string' || worldToken.trim().length < 16) {
      throw new Error('已启用世界交互，但未提供至少 16 位的 world token；拒绝启动')
    }
    const worldTokenHash = createHash('sha256').update(worldToken).digest('hex')
    if (credentials.some((credential) => credential.tokenHash === worldTokenHash)) {
      throw new Error('world token 不得与任何聊天 API Token 相同')
    }
    worldRouter = createWorldRouter({
      service: runtime.world,
      token: worldToken,
      devMode: opts.world?.devMode === true,
      // 实例由持久层权威解析，**不接受**请求体指定
      resolveInstance: (worldId) => runtime.persistence.listInstances({ worldId })[0]?.id ?? null,
      readBody,
      readJson,
      json,
      checkRate,
    })
  }

  async function readBody(req: IncomingMessage): Promise<string> {
    return await new Promise((resolve, reject) => {
      let size = 0
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > bodyLimit) {
          reject(new HttpError(413, 'BODY_TOO_LARGE', `请求体超过 ${bodyLimit} 字节`))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', (err) => reject(err))
    })
  }

  function readJson(raw: string): Record<string, unknown> {
    if (raw.trim().length === 0) return {}
    try {
      const parsed = JSON.parse(raw) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new HttpError(400, 'INVALID_BODY', '请求体必须是 JSON 对象')
      }
      return parsed as Record<string, unknown>
    } catch (err) {
      if (err instanceof HttpError) throw err
      throw new HttpError(400, 'INVALID_JSON', '请求体不是合法 JSON')
    }
  }

    function authenticate(req: IncomingMessage): { platformUserId: string; tokenHash: string } {
        const header = req.headers.authorization
        if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
            throw new HttpError(401, 'UNAUTHORIZED', '缺少或无效的 Bearer Token')
        }
        const providedHash = createHash('sha256').update(header.slice('Bearer '.length).trim()).digest('hex')
        let principal: (typeof credentials)[number] | undefined
        for (const credential of credentials) {
            if (safeEqual(providedHash, credential.tokenHash)) principal = credential
        }
        if (!principal) throw new HttpError(401, 'UNAUTHORIZED', '缺少或无效的 Bearer Token')
        return principal
    }

    // Client identity fields are assertions, never authority to select a subject.
    function resolveIdentity(
        req: IncomingMessage,
        principal: { platformUserId: string },
        body?: Record<string, unknown>,
    ): { platformUserId: string; displayName?: string } {
        const requestedHeader = req.headers['x-characterlife-identity']
        const requestedBody = body?.identity
        for (const requested of [requestedHeader, requestedBody]) {
            if (requested !== undefined && requested !== principal.platformUserId) {
                throw new HttpError(403, 'IDENTITY_MISMATCH', '请求身份与凭据授权身份不符')
            }
        }
        return { platformUserId: principal.platformUserId }
    }

  function json(res: ServerResponse, status: number, payload: unknown): void {
    const text = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  function fail(res: ServerResponse, err: unknown): void {
    if (err instanceof HttpError) {
      json(res, err.status, { error: { message: err.message, type: 'invalid_request_error', code: err.code } })
      return
    }
    if (err instanceof SillyTavernRequestError) {
      json(res, 400, { error: { message: err.message, type: 'invalid_request_error', code: 'BAD_REQUEST' } })
      return
    }
    json(res, 500, { error: { message: '服务暂时不可用', type: 'server_error', code: 'INTERNAL' } })
  }

  async function runTurn(
    message: NormalizedMessage,
    notices: string[],
  ): Promise<{ reply: string; instanceId: string; sessionId: string; promptTokens: number; completionTokens: number }> {
    const outcome = await runtime.gateway.handleMessage(runtime.sillyTavernAdapter, message, notices)
    if (!outcome.reply) {
      throw new HttpError(502, 'NO_REPLY', '引擎未产生回复')
    }
    return {
      reply: outcome.reply,
      instanceId: outcome.instanceId ?? '',
      sessionId: outcome.sessionId ?? '',
      promptTokens: outcome.usage?.promptTokens ?? 0,
      completionTokens: outcome.usage?.completionTokens ?? 0,
    }
  }

  const server = createServer((req, res) => {
    const started = Date.now()
    const method = req.method ?? 'GET'
    const path = (req.url ?? '/').split('?')[0] ?? '/'

    res.on('finish', () => {
      logger(
        JSON.stringify({
          t: new Date().toISOString(),
          method,
          path,
          status: res.statusCode,
          ms: Date.now() - started,
        }),
      )
    })

    void (async () => {
      try {
        if (method === 'GET' && (path === '/healthz' || path === '/health')) {
          json(res, 200, { ok: true, service: 'characterlife', uptimeSec: Math.round(process.uptime()) })
          return
        }

        // 世界交互使用独立 token：不能复用聊天鉴权，也不能被聊天 token 调用。
        if (path === '/v1/world' || path.startsWith('/v1/world/')) {
          if (!worldRouter) throw new HttpError(404, 'WORLD_DISABLED', '世界交互未启用')
          await worldRouter.handle(req, res)
          return
        }

        const principal = authenticate(req)
        resolveIdentity(req, principal)

        if (!checkRate(principal.tokenHash)) throw new HttpError(429, 'RATE_LIMITED', '请求过于频繁')

        /* ---------------------------- OpenAI 兼容 ---------------------------- */
        if (method === 'GET' && path === '/v1/models') {
          json(res, 200, buildModelsResponse({ models: [{ id: modelId, label: 'CharacterLife 持久角色' }] }))
          return
        }

        if (method === 'POST' && path === '/v1/chat/completions') {
          const body = readJson(await readBody(req))
          const identity = resolveIdentity(req, principal, body)
          const message = runtime.sillyTavernAdapter.build(
            body as Parameters<RuntimeBundle['sillyTavernAdapter']['build']>[0],
            identity,
            headerValue(req.headers['x-request-id']),
          )
          const result = await runTurn(message, [])
          const model = typeof body.model === 'string' ? body.model : modelId

          if (body.stream === true) {
            res.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-cache',
              connection: 'keep-alive',
            })
            let aborted = false
            req.on('close', () => {
              aborted = true
            })
            for (const chunk of buildSSEChunks({ model, reply: result.reply })) {
              if (aborted) break
              res.write(chunk)
            }
            if (!aborted) res.end()
            return
          }

          json(
            res,
            200,
            buildChatCompletionResponse({
              model,
              reply: result.reply,
              promptTokens: result.promptTokens,
              completionTokens: result.completionTokens,
            }),
          )
          return
        }

        /* ------------------------------ 原生接口 ------------------------------ */
        if (method === 'POST' && path === '/v1/messages') {
          const body = readJson(await readBody(req))
          const identity = resolveIdentity(req, principal, body)
          const text = typeof body.text === 'string' ? body.text : ''
          if (text.trim().length === 0) throw new HttpError(400, 'EMPTY_TEXT', 'text 不能为空')
          const notices = Array.isArray(body.notices) ? body.notices.map(String) : []
          const message = runtime.sillyTavernAdapter.build(
            { messages: [{ role: 'user', content: text }] },
            identity,
            headerValue(req.headers['x-request-id']),
          )
          const result = await runTurn(message, notices)
          const instanceId = result.instanceId || runtime.identityService.instanceFor('sillytavern', identity.platformUserId) || ''
          const rt = instanceId ? runtime.runtimeManager.get(instanceId) : null
          const view = rt ? rt.workspace.view() : null
          json(res, 200, {
            reply: result.reply,
            instanceId,
            sessionId: result.sessionId,
            state: view
              ? {
                  name: view.character.name,
                  stage: view.relationship.stage,
                  trust: view.relationship.trust,
                  familiarity: view.relationship.familiarity,
                  memories: view.memory.total,
                  milestones: view.relationship.milestones.length,
                }
              : null,
          })
          return
        }

        if (method === 'POST' && path === '/v1/sessions') {
          const body = readJson(await readBody(req))
          const identity = resolveIdentity(req, principal, body)
          const resolved = runtime.identityService.resolveOrCreate(
            'sillytavern',
            identity.platformUserId,
            identity.displayName,
          )
          const rt = runtime.runtimeManager.get(resolved.instance.id)
          const sessionId = runtime.runtimeManager.newSession(rt, `sillytavern:${identity.platformUserId}`)
          runtime.runtimeManager.saveSnapshot(rt)
          json(res, 200, { instanceId: resolved.instance.id, sessionId })
          return
        }

        const stateMatch = /^\/v1\/characters\/([A-Za-z0-9_\-:]+)\/(state|memories)$/.exec(path)
        if (method === 'GET' && stateMatch) {
          const instanceId = stateMatch[1]!
          const kind = stateMatch[2]!
          if (!runtime.persistence.getInstance(instanceId)) {
            throw new HttpError(404, 'INSTANCE_NOT_FOUND', `实例 ${instanceId} 不存在`)
          }
          const callerInstance = runtime.identityService.instanceFor('sillytavern', resolveIdentity(req, principal).platformUserId)
          if (callerInstance !== instanceId) {
            throw new HttpError(403, 'FORBIDDEN', '只能查看自己绑定的角色实例')
          }
          const rt = runtime.runtimeManager.get(instanceId)
          if (kind === 'state') {
            const view = rt.workspace.view()
            json(res, 200, {
              instanceId,
              character: view.character,
              stage: view.relationship.stage,
              trust: view.relationship.trust,
              familiarity: view.relationship.familiarity,
              memories: view.memory.total,
              milestones: view.relationship.milestones.length,
              mood: view.dynamic.mood.label,
              pendingMessages: view.pendingMessages,
              conflicts: rt.conflicts.length,
              platforms: runtime.identityService.listBindings(instanceId).map((b) => b.platform),
            })
            return
          }
          json(res, 200, {
            instanceId,
            memories: rt.workspace.memory.list().map((m) => ({
              id: m.id,
              title: m.title,
              status: m.status,
              trust: m.trust,
              confirmed: m.confirmed,
              createdAtSim: m.createdAtSim,
            })),
          })
          return
        }

        const memoryMatch = /^\/v1\/memories\/([A-Za-z0-9_\-]+)$/.exec(path)
        if (method === 'DELETE' && memoryMatch) {
          const memoryId = memoryMatch[1]!
          const identity = resolveIdentity(req, principal)
          const instanceId = runtime.identityService.instanceFor('sillytavern', identity.platformUserId)
          if (!instanceId) throw new HttpError(403, 'FORBIDDEN', '当前身份还没有绑定的角色实例')
          const rt = runtime.runtimeManager.get(instanceId)
          if (!rt.workspace.memory.get(memoryId)) {
            throw new HttpError(404, 'MEMORY_NOT_FOUND', `记忆 ${memoryId} 不存在或不属于当前实例`)
          }
          const ok = rt.workspace.deleteMemory(memoryId, OWNER_ACTOR)
          runtime.runtimeManager.saveSnapshot(rt)
          json(res, ok ? 200 : 500, { deleted: ok, memoryId })
          return
        }

        /* ------------------------------ 身份绑定 ------------------------------ */
        if (method === 'GET' && path === '/v1/identity/me') {
          const identity = resolveIdentity(req, principal)
          const binding = runtime.platformStore.getBinding('sillytavern', identity.platformUserId)
          json(res, 200, {
            platform: 'sillytavern',
            platformUserId: identity.platformUserId,
            instanceId: binding?.instanceId ?? null,
            boundAt: binding?.createdAtWall ?? null,
            source: binding?.source ?? null,
          })
          return
        }

        if (method === 'POST' && path === '/v1/identity/bind-code') {
          const body = readJson(await readBody(req))
          const identity = resolveIdentity(req, principal, body)
          const resolved = runtime.identityService.resolveOrCreate(
            'sillytavern',
            identity.platformUserId,
            identity.displayName,
          )
          const target = typeof body.targetPlatform === 'string' ? body.targetPlatform : 'qq'
          const issued = runtime.identityService.issueBindCode({
            instanceId: resolved.instance.id,
            targetPlatform: target,
            createdBy: `sillytavern:${identity.platformUserId}`,
          })
          json(res, 200, {
            instanceId: resolved.instance.id,
            targetPlatform: target,
            code: issued.code,
            expiresAt: issued.expiresAt,
          })
          return
        }

        if (method === 'POST' && path === '/v1/identity/redeem') {
          const body = readJson(await readBody(req))
          const identity = resolveIdentity(req, principal, body)
          const code = typeof body.code === 'string' ? body.code.trim() : ''
          if (!/^\d{8}$/.test(code)) throw new HttpError(400, 'BAD_CODE', '绑定码必须是 8 位数字')
          const result = runtime.identityService.redeemBindCode({
            code,
            platform: 'sillytavern',
            platformUserId: identity.platformUserId,
            displayName: identity.displayName,
          })
          if (!result.ok) {
            throw new HttpError(
              result.error === 'NOT_FOUND' ? 404 : 400,
              result.error ?? 'BIND_FAILED',
              `绑定失败：${result.error}`,
            )
          }
          json(res, 200, {
            instanceId: result.instanceId,
            platform: 'sillytavern',
            platformUserId: identity.platformUserId,
          })
          return
        }

        if (method === 'DELETE' && path === '/v1/identity/binding') {
          const identity = resolveIdentity(req, principal)
          const ok = runtime.identityService.unbind('sillytavern', identity.platformUserId)
          json(res, 200, { unbound: ok })
          return
        }

        throw new HttpError(404, 'NOT_FOUND', `未知接口：${method} ${path}`)
      } catch (err) {
        fail(res, err)
      }
    })()
  })

  return {
    server,
    get url() {
      return url
    },
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(opts.port ?? 8787, host, () => resolve())
      })
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : (opts.port ?? 8787)
      url = `http://${host === '::1' ? '[::1]' : host}:${port}`
      return { host, port, url }
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
