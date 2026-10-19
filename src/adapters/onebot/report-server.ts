/**
 * OneBot 11 事件上报服务（HTTP 上报模式的入口）。
 *
 * 为什么把 HTTP 服务放进 `src/adapters/` 而不是 `examples/`：
 * QQ 官方的 webhook 服务写在 examples 里，代价是它**没法被测试**
 * （签名、应答、去重全链路只能靠真平台）。这里反过来：服务本体可注入、
 * 可测（`tests/adapters/onebot-http.test.ts` 起真实端口跑一遍），
 * `examples/onebot/server.ts` 只是读环境变量的薄壳。
 *
 * 应答策略：**先 204，再处理**。OneBot 网关对上报请求有超时（通常 5s 左右），
 * 而一轮对话要调模型（1~3s）。先回 204 让网关不再重试，重投的幂等性由
 * `processed_messages` 兜底 —— 反正 message_id 是稳定的。
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { RuntimeBundle } from '../../api/runtime-factory.ts'
import { verifyOneBotSignature } from './webhook.ts'

export interface OneBotReportServerOptions {
  runtime: RuntimeBundle
  /** 网关里配置的 secret；为空则跳过签名校验（会打印一条警告） */
  secret?: string | null
  /** 事件上报路径，默认 /onebot/event */
  path?: string
  host?: string
  port?: number
  allowNonLoopback?: boolean
  bodyLimitBytes?: number
  logger?: (line: string) => void
}

export interface OneBotReportServerHandle {
  server: Server
  readonly url: string | null
  readonly inflight: number
  listen(): Promise<{ host: string; port: number; url: string }>
  /** 等待所有在途事件处理完；超时返回 false（测试与优雅退出用） */
  waitIdle(timeoutMs?: number): Promise<boolean>
  close(): Promise<void>
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

function headerValue(value: string | string[] | undefined): string | undefined {
  if (typeof value === 'string') return value
  if (Array.isArray(value) && value.length > 0) return value[0]
  return undefined
}

export function createOneBotReportServer(opts: OneBotReportServerOptions): OneBotReportServerHandle {
  const host = opts.host ?? '127.0.0.1'
  if (!LOOPBACK.has(host) && !opts.allowNonLoopback) {
    throw new Error(`拒绝绑定非回环地址 ${host}：需要显式 allowNonLoopback=true（OneBot 网关通常与本体同机）`)
  }
  const { runtime } = opts
  const adapter = runtime.onebotAdapter
  if (!adapter) {
    throw new Error('运行时没有装配 OneBot 适配器：请先给 assembleRuntime 传 onebot 配置')
  }
  const path = opts.path ?? '/onebot/event'
  const bodyLimit = opts.bodyLimitBytes ?? 256 * 1024
  const logger = opts.logger ?? ((line: string) => console.log(line))
  const secret = opts.secret && opts.secret.length > 0 ? opts.secret : null
  const inflight = new Set<Promise<unknown>>()
  let url: string | null = null

  const log = (payload: Record<string, unknown>): void => {
    logger(JSON.stringify({ t: new Date().toISOString(), ...payload }))
  }

  if (!secret) {
    log({ level: 'warn', msg: 'OneBot 上报未配置 secret：任何能访问该端口的人都能伪造消息。生产请配置 secret 且只监听回环地址。' })
  }

  const track = (promise: Promise<unknown>): void => {
    inflight.add(promise)
    void promise.finally(() => inflight.delete(promise)).catch(() => {})
  }

  async function readBody(req: IncomingMessage): Promise<string> {
    return await new Promise((resolve, reject) => {
      let size = 0
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > bodyLimit) {
          reject(new Error(`BODY_TOO_LARGE:${bodyLimit}`))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', (err) => reject(err))
    })
  }

  function json(res: ServerResponse, status: number, payload: unknown): void {
    const text = JSON.stringify(payload)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
    res.end(text)
  }

  const server = createServer((req, res) => {
    const started = Date.now()
    const method = req.method ?? 'GET'
    const requestPath = (req.url ?? '/').split('?')[0] ?? '/'

    void (async () => {
      try {
        // 健康检查：给 supervisor / 反代用，不含任何用户数据
        if (method === 'GET' && (requestPath === '/healthz' || requestPath === '/health')) {
          json(res, 200, {
            ok: true,
            service: 'characterlife-onebot',
            uptimeSec: Math.round(process.uptime()),
            adapter: adapter.describe(),
            signature: secret ? 'on' : 'off',
            inflight: inflight.size,
          })
          return
        }

        if (requestPath !== path) {
          json(res, 404, { error: { code: 'NOT_FOUND', message: `未知路径：${method} ${requestPath}` } })
          return
        }
        if (method !== 'POST') {
          json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: '事件上报只接受 POST' } })
          return
        }

        let rawBody: string
        try {
          rawBody = await readBody(req)
        } catch (err) {
          const message = (err as Error).message
          if (message.startsWith('BODY_TOO_LARGE')) {
            json(res, 413, { error: { code: 'BODY_TOO_LARGE', message: `请求体超过 ${bodyLimit} 字节` } })
            return
          }
          throw err
        }

        const signature = verifyOneBotSignature({
          secret,
          rawBody,
          signatureHeader: headerValue(req.headers['x-signature']),
        })
        if (!signature.ok) {
          log({ level: 'warn', msg: '事件上报签名校验失败', reason: signature.reason })
          json(res, 401, { error: { code: signature.reason, message: '签名校验失败' } })
          return
        }

        let payload: unknown
        try {
          payload = rawBody.trim().length === 0 ? {} : JSON.parse(rawBody)
        } catch {
          json(res, 400, { error: { code: 'INVALID_JSON', message: '事件不是合法 JSON' } })
          return
        }

        // 先应答：网关不等我们调完模型
        res.writeHead(204).end()

        track(
          runtime.gateway
            .handleRaw('onebot', payload)
            .then((outcome) => {
              // 只记事件类型与结果，不记消息正文
              const kind =
                payload && typeof payload === 'object'
                  ? `${String((payload as Record<string, unknown>).post_type ?? '?')}/${String((payload as Record<string, unknown>).message_type ?? '-')}`
                  : '?'
              log({
                level: 'info',
                kind,
                status: outcome.status,
                instance: outcome.instanceId ?? null,
                reason: outcome.reason ?? null,
                ms: Date.now() - started,
              })
            })
            .catch((err: unknown) => {
              log({ level: 'error', msg: '事件处理失败', error: (err as Error).message })
            }),
        )
      } catch (err) {
        if (!res.headersSent) {
          json(res, 500, { error: { code: 'INTERNAL', message: (err as Error).message } })
        } else {
          log({ level: 'error', msg: '应答后异常', error: (err as Error).message })
        }
      }
    })()
  })

  const handle: OneBotReportServerHandle = {
    server,
    get url() {
      return url
    },
    get inflight() {
      return inflight.size
    },
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(opts.port ?? 8790, host, () => resolve())
      })
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : (opts.port ?? 8790)
      url = `http://${host === '::1' ? '[::1]' : host}:${port}`
      return { host, port, url }
    },
    async waitIdle(timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs
      while (inflight.size > 0) {
        if (Date.now() > deadline) return false
        await Promise.allSettled([...inflight])
      }
      return true
    },
    async close() {
      // 先等在途事件处理完（否则正在调模型的这一轮会被直接掐断）
      await handle.waitIdle()
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        // HTTP keep-alive 会让 close() 一直等下去，这里主动断开空闲连接
        server.closeAllConnections?.()
      })
    },
  }

  return handle
}
