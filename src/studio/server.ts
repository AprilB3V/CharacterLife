/**
 * Character studio: a local web page for creating and editing character packs without touching JSON.
 *
 * - Loopback only. The page is opened through a one-time link carrying a random token; the token
 *   moves into an HttpOnly, SameSite=Strict cookie, and every API call needs it. Requests whose Host
 *   is not this loopback address are refused (DNS rebinding).
 * - It writes only `<charactersDir>/<id>/`, through saveCharacterPack, which validates everything and
 *   bumps `version` when the character changed (DECISIONS §22).
 * - It never touches databases. Running servers pick changes up on restart, when existing
 *   conversations migrate to the new version.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import type { LLMProvider } from '../kernel/types.ts'
import { CharacterPackError, loadCharacterPack, packModelId, validatePackManifest } from '../character/pack.ts'
import type { CharacterPackManifest } from '../character/pack.ts'
import { saveCharacterPack, scanCharacterPacks } from '../character/pack-library.ts'
import { DraftError, blankPack, draftFromDescription, draftLanguage } from '../character/pack-draft.ts'
import { CardError, MAX_CARD_BYTES, importCharacterCard } from '../character/st-card.ts'

const PAGE = join(import.meta.dirname, 'public', 'studio.html')
const COOKIE = 'cl_studio'
const JSON_LIMIT = 512 * 1024
const PENDING_TTL_MS = 60 * 60_000
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' }

export interface StudioOptions {
  charactersDir: string
  /** Model for "describe your character" drafts; null or a mock disables that button. */
  provider?: LLMProvider | null
  port?: number
  /** Fixed token for tests; normally random per start. */
  token?: string
  /** Default author name for new packs. */
  author?: string
}

export interface StudioHandle {
  server: Server
  listen(): Promise<{ url: string; openUrl: string }>
  close(): Promise<void>
}

class StudioError extends Error {
  readonly status: number
  readonly code: string
  readonly issues: unknown[]
  constructor(status: number, code: string, message: string, issues: unknown[] = []) {
    super(message)
    this.status = status
    this.code = code
    this.issues = issues
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

async function readBytes(req: IncomingMessage, limit: number): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        reject(new StudioError(413, 'TOO_LARGE', `larger than ${limit} bytes`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = (await readBytes(req, JSON_LIMIT)).toString('utf8')
  try {
    const parsed = JSON.parse(raw || '{}') as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // fall through
  }
  throw new StudioError(400, 'INVALID_JSON', 'body must be a JSON object')
}

function cookieToken(req: IncomingMessage): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === COOKIE) return v.join('=')
  }
  return null
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export function createStudioServer(opts: StudioOptions): StudioHandle {
  const token = opts.token ?? randomBytes(24).toString('base64url')
  const root = opts.charactersDir
  const provider = opts.provider && opts.provider.name !== 'mock' ? opts.provider : null
  const author = opts.author ?? 'me'
  /** Files from an imported card (portrait, notes) waiting for the owner to save the draft. */
  const pending = new Map<string, { files: Record<string, Uint8Array>; at: number }>()
  let port = 0

  const sweep = () => {
    const now = Date.now()
    for (const [id, p] of pending) if (now - p.at > PENDING_TTL_MS) pending.delete(id)
  }

  const listCharacters = () => {
    const scan = scanCharacterPacks(root)
    return {
      dir: root,
      characters: scan.packs.map((p) => ({
        id: p.manifest.id,
        name: p.manifest.name,
        version: p.manifest.version,
        language: p.manifest.language,
        summary: p.manifest.summary,
        model: packModelId(p.manifest),
        portrait: Boolean(p.files.portrait),
      })),
      errors: scan.errors,
    }
  }

  const route = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const method = req.method ?? 'GET'
    const path = url.pathname

    if (method === 'GET' && path === '/') {
      const given = url.searchParams.get('token')
      if (given !== null) {
        if (!same(given, token)) throw new StudioError(403, 'FORBIDDEN', 'this link is no longer valid; restart the studio for a new one')
        res.writeHead(303, {
          'set-cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
          location: '/',
          'cache-control': 'no-store',
        })
        res.end()
        return
      }
      const cookie = cookieToken(req)
      if (!cookie || !same(cookie, token)) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('Open the studio with the link printed in the terminal.\n请用终端里打印的链接打开角色工作室。\n')
        return
      }
      const html = readFileSync(PAGE)
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
        'x-content-type-options': 'nosniff',
      })
      res.end(html)
      return
    }

    if (!path.startsWith('/api/')) throw new StudioError(404, 'NOT_FOUND', 'not found')
    const cookie = cookieToken(req)
    if (!cookie || !same(cookie, token)) throw new StudioError(401, 'UNAUTHORIZED', 'open the studio with the link printed in the terminal')
    // Writes must come from this page: browsers send Origin on POST.
    if (method !== 'GET') {
      const origin = req.headers.origin
      if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
        throw new StudioError(403, 'FORBIDDEN', 'cross-origin request')
      }
    }

    if (method === 'GET' && path === '/api/state') {
      return send(res, 200, { ...listCharacters(), draftModel: provider ? provider.model : null, author })
    }

    const parts = path.split('/').filter(Boolean).map(decodeURIComponent)
    if (method === 'GET' && parts[1] === 'characters' && parts.length === 3) {
      const dir = join(root, parts[2]!)
      if (!/^[a-z0-9-]+$/.test(parts[2]!) || !existsSync(join(dir, 'character.json'))) throw new StudioError(404, 'NOT_FOUND', 'no such character')
      const pack = loadCharacterPack(dir)
      return send(res, 200, { manifest: pack.manifest, model: packModelId(pack.manifest) })
    }
    if (method === 'GET' && parts[1] === 'characters' && parts[3] === 'portrait' && parts.length === 4) {
      if (!/^[a-z0-9-]+$/.test(parts[2]!)) throw new StudioError(404, 'NOT_FOUND', 'no such character')
      const pack = loadCharacterPack(join(root, parts[2]!))
      const file = pack.files.portrait
      if (!file) throw new StudioError(404, 'NOT_FOUND', 'no portrait')
      const bytes = readFileSync(file)
      res.writeHead(200, { 'content-type': IMAGE_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store' })
      res.end(bytes)
      return
    }

    if (method === 'POST' && path === '/api/blank') {
      const body = await readJson(req)
      const name = typeof body.name === 'string' ? body.name.slice(0, 80) : ''
      return send(res, 200, blankPack(name, draftLanguage(String(body.language ?? '')), author))
    }

    if (method === 'POST' && path === '/api/import-card') {
      const bytes = await readBytes(req, MAX_CARD_BYTES)
      const language = url.searchParams.get('language')
      const imported = importCharacterCard(bytes, language ? { language: draftLanguage(language) } : {})
      sweep()
      const pendingId = randomBytes(12).toString('base64url')
      pending.set(pendingId, { files: imported.files, at: Date.now() })
      return send(res, 200, {
        manifest: imported.manifest,
        placeholders: imported.placeholders,
        notes: imported.notes,
        pendingId,
        portrait: imported.files['portrait.png'] ? `data:image/png;base64,${Buffer.from(imported.files['portrait.png']).toString('base64')}` : null,
        card: { spec: imported.card.spec, name: imported.card.name },
      })
    }

    if (method === 'POST' && path === '/api/draft') {
      if (!provider) throw new StudioError(503, 'NO_MODEL', 'no model is configured for drafts')
      const body = await readJson(req)
      const language = typeof body.language === 'string' && body.language ? draftLanguage(body.language) : undefined
      const draft = await draftFromDescription(provider, String(body.description ?? ''), { ...(language ? { language } : {}), author })
      return send(res, 200, draft)
    }

    if (method === 'POST' && path === '/api/validate') {
      const body = await readJson(req)
      return send(res, 200, { issues: validatePackManifest({ ...(body.manifest as object), version: 1 }) })
    }

    if (method === 'POST' && path === '/api/characters') {
      const body = await readJson(req)
      const manifest = body.manifest as CharacterPackManifest
      const pendingId = typeof body.pendingId === 'string' ? body.pendingId : null
      const files = pendingId ? pending.get(pendingId)?.files ?? {} : {}
      const existing = typeof manifest?.id === 'string' && existsSync(join(root, manifest.id, 'character.json'))
      if (existing && body.create === true) {
        throw new StudioError(409, 'EXISTS', `a character with id "${manifest.id}" already exists; pick another id`)
      }
      const saved = saveCharacterPack(root, manifest, files)
      if (pendingId) pending.delete(pendingId)
      return send(res, 200, {
        id: saved.manifest.id,
        version: saved.manifest.version,
        created: saved.created,
        bumped: saved.bumped,
        dir: saved.dir,
        model: packModelId(saved.manifest),
      })
    }

    throw new StudioError(404, 'NOT_FOUND', `unknown endpoint ${method} ${path}`)
  }

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const host = req.headers.host ?? ''
        if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) throw new StudioError(403, 'FORBIDDEN', 'unexpected Host header')
        await route(req, res, new URL(req.url ?? '/', `http://127.0.0.1:${port}`))
      } catch (error) {
        if (res.headersSent) return
        if (error instanceof StudioError) return send(res, error.status, { error: { code: error.code, message: error.message, issues: error.issues } })
        if (error instanceof CharacterPackError) return send(res, 422, { error: { code: 'INVALID_PACK', message: 'the character has problems', issues: error.issues } })
        if (error instanceof CardError) return send(res, 422, { error: { code: 'INVALID_CARD', message: error.message, issues: [] } })
        if (error instanceof DraftError) return send(res, 422, { error: { code: 'DRAFT_FAILED', message: error.message, issues: error.issues } })
        send(res, 500, { error: { code: 'INTERNAL', message: (error as Error).message, issues: [] } })
      }
    })()
  })

  return {
    server,
    async listen() {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(opts.port ?? 8790, '127.0.0.1', () => resolve())
      })
      const address = server.address()
      port = typeof address === 'object' && address ? address.port : (opts.port ?? 8790)
      const url = `http://127.0.0.1:${port}`
      return { url, openUrl: `${url}/?token=${token}` }
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
