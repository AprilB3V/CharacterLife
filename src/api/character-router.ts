/**
 * One OpenAI-compatible endpoint for several characters.
 *
 * Each character keeps its own runtime and database behind its own ApiServerHandle; the router only
 * picks which handler serves a request. OpenAI clients pick a character by `model`
 * ("characterlife/<pack id>", what SillyTavern's model dropdown sends). Native endpoints that carry
 * no model use the `X-CharacterLife-Model` header or `?model=`; without either, the first character
 * answers, so single-character clients keep working unchanged.
 */

import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { PRELOADED_BODY } from './server.ts'
import type { ApiServerHandle, PreloadedRequest } from './server.ts'

export const MODEL_HEADER = 'x-characterlife-model'
const MODEL_PREFIX = 'characterlife/'
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])

export interface RoutedCharacter {
  modelId: string
  label: string
  api: Pick<ApiServerHandle, 'handle'>
}

export interface CharacterRouterOptions {
  /** The first character is the default for requests that name none. */
  characters: readonly RoutedCharacter[]
  host?: string
  port?: number
  allowNonLoopback?: boolean
  bodyLimitBytes?: number
}

export interface CharacterRouterHandle {
  server: Server
  handle(req: IncomingMessage, res: ServerResponse): void
  listen(): Promise<{ host: string; port: number; url: string }>
  close(): Promise<void>
  readonly url: string | null
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  const text = JSON.stringify({ error: { message, type: 'invalid_request_error', code } })
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/** Read the whole body, or null when it exceeds the limit (the request is then destroyed). */
async function readLimited(req: IncomingMessage, limit: number): Promise<string | null> {
  return await new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function modelFromBody(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed && typeof parsed === 'object' && typeof (parsed as { model?: unknown }).model === 'string') {
      return (parsed as { model: string }).model
    }
  } catch {
    // Not JSON: the character's own handler reports it.
  }
  return undefined
}

export function createCharacterRouter(opts: CharacterRouterOptions): CharacterRouterHandle {
  const host = opts.host ?? '127.0.0.1'
  if (!LOOPBACK.has(host) && !opts.allowNonLoopback) {
    throw new Error(`拒绝绑定非回环地址 ${host}：需要显式 allowNonLoopback=true`)
  }
  if (opts.characters.length === 0) throw new Error('character router needs at least one character')
  const byModel = new Map<string, RoutedCharacter>()
  for (const character of opts.characters) {
    if (byModel.has(character.modelId)) throw new Error(`duplicate model id ${character.modelId}`)
    byModel.set(character.modelId, character)
  }
  const primary = opts.characters[0]!
  const bodyLimit = opts.bodyLimitBytes ?? 256 * 1024
  let url: string | null = null

  /** Unknown "characterlife/…" names are an error; any other name (e.g. "gpt-4o") falls back to the default. */
  const pick = (model: string | undefined): RoutedCharacter | null => {
    if (!model) return primary
    const found = byModel.get(model)
    if (found) return found
    return model.startsWith(MODEL_PREFIX) ? null : primary
  }

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      try {
        const method = req.method ?? 'GET'
        const query = new URL(req.url ?? '/', 'http://router').searchParams.get('model') ?? undefined
        const header = req.headers[MODEL_HEADER]
        let model = (Array.isArray(header) ? header[0] : header) ?? query
        if (method !== 'GET' && method !== 'HEAD') {
          const raw = await readLimited(req, bodyLimit)
          if (raw === null) return sendError(res, 413, 'BODY_TOO_LARGE', `请求体超过 ${bodyLimit} 字节`)
          ;(req as PreloadedRequest)[PRELOADED_BODY] = raw
          model ??= modelFromBody(raw)
        }
        const target = pick(model)
        if (!target) {
          const known = [...byModel.keys()].join(', ')
          return sendError(res, 404, 'MODEL_NOT_FOUND', `没有角色 ${model}；可用：${known}`)
        }
        target.api.handle(req, res)
      } catch {
        if (!res.headersSent) sendError(res, 500, 'INTERNAL', '服务暂时不可用')
      }
    })()
  }
  const server = createServer(handle)

  return {
    server,
    handle,
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
