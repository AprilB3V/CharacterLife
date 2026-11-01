/**
 * Owner console: a loopback-only backend for inspecting the six semantics of each
 * instance, reviewing held memories, and hosting engine-layer plugins.
 *
 * - Runs inside the CL process, so it shares the in-memory runtime and never becomes
 *   a second writer to the database.
 * - Every API call needs the console Bearer token (separate from the chat token).
 *   Static assets are public; they hold no data.
 * - Mutations run under the per-instance lock and save a snapshot afterwards.
 */
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createHash, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import type { RuntimeBundle } from '../api/runtime-factory.ts'
import type { InstanceRuntime } from '../runtime/instance-runtime.ts'
import { OWNER_ACTOR } from '../kernel/policy/policy.ts'
import type { ConsolePlugin, ConsoleValue } from './plugin.ts'

export interface ConsoleServerOptions {
    runtime: RuntimeBundle
    token: string
    host?: string
    port?: number
}

export interface ConsoleServerHandle {
    server: Server
    listen(): Promise<{ url: string }>
    close(): Promise<void>
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1'])
const BODY_LIMIT = 64 * 1024
const ACTOR_ID = 'console-owner'
const PUBLIC_DIR = join(import.meta.dirname, 'public')
const ASSETS: Record<string, { file: string; type: string }> = {
    '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
    '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
    '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
}

class ConsoleError extends Error {
    readonly status: number
    readonly code: string
    constructor(status: number, code: string, message: string) {
        super(message)
        this.status = status
        this.code = code
    }
}

const digest = (value: string) => createHash('sha256').update(value).digest()

function send(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) {
        throw new ConsoleError(400, 'INVALID_CONTENT_TYPE', '请使用 application/json 请求体')
    }
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
        size += (chunk as Buffer).length
        if (size > BODY_LIMIT) throw new ConsoleError(413, 'BODY_TOO_LARGE', '请求体超过 64 KiB')
        chunks.push(chunk as Buffer)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    const value: unknown = text ? JSON.parse(text) : {}
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConsoleError(400, 'INVALID_BODY', '请求体必须是对象')
    return value as Record<string, unknown>
}

function boundedInt(value: string | null, fallback: number, max: number): number {
    if (value === null) return fallback
    const number = Number(value)
    if (!/^\d+$/.test(value) || number < 1 || number > max) throw new ConsoleError(400, 'INVALID_QUERY', `参数必须是 1–${max} 的整数`)
    return number
}

function scalarParams(value: unknown): Record<string, ConsoleValue> {
    if (value === undefined) return {}
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ConsoleError(400, 'INVALID_PARAMS', 'params 必须是对象')
    const result: Record<string, ConsoleValue> = {}
    for (const [key, item] of Object.entries(value)) {
        if (item !== null && !['string', 'number', 'boolean'].includes(typeof item)) throw new ConsoleError(400, 'INVALID_PARAMS', `参数 ${key} 必须是标量`)
        result[key] = item as ConsoleValue
    }
    return result
}

/** Read-only snapshot of the six semantics for one instance. */
export function semanticsView(rt: InstanceRuntime, observationLimit = 50) {
    const ws = rt.workspace
    const all = ws.memory.list({ includeDeleted: true, limit: Number.MAX_SAFE_INTEGER })
    const live = all.filter(memory => memory.deletedAtSim === null)
    const count = (key: (memory: typeof all[number]) => string) => live.reduce<Record<string, number>>((acc, memory) => {
        acc[key(memory)] = (acc[key(memory)] ?? 0) + 1
        return acc
    }, {})
    const plugin = rt.extension?.consolePlugin?.()
    return {
        instanceId: rt.instanceId,
        worldId: rt.worldId,
        self: { persona: ws.self.persona, condition: ws.self.condition() },
        situation: ws.situation.current(),
        observation: { lastSeq: ws.observation.lastSeq, latest: ws.observation.latest(observationLimit).reverse() },
        memory: { total: live.length, deleted: all.length - live.length, byKind: count(memory => memory.kind),
            byStatus: count(memory => memory.status), byOrigin: count(memory => memory.origin), relationship: ws.relationship },
        motivation: { goals: ws.motivation.goals(), drives: ws.motivation.drives(), commitments: ws.motivation.commitments() },
        affordance: Object.fromEntries(ws.affordance.channels().map(channel => [channel, ws.affordance.list(channel)])),
        review: { memories: rt.memoryReview.list('pending').length },
        plugins: plugin ? [{ id: plugin.id, title: plugin.title }] : [],
    }
}

export function createConsoleServer(opts: ConsoleServerOptions): ConsoleServerHandle {
    const host = opts.host ?? '127.0.0.1'
    if (!LOOPBACK.has(host)) throw new Error('The console only listens on a loopback address')
    if (!opts.token || opts.token.length < 16) throw new Error('The console token must be at least 16 characters')
    const expected = digest(opts.token)
    const { runtime } = opts
    const manager = runtime.runtimeManager

    const authorized = (req: IncomingMessage) => {
        const header = req.headers.authorization ?? ''
        return header.startsWith('Bearer ') && timingSafeEqual(digest(header.slice(7)), expected)
    }

    const instance = (id: string): InstanceRuntime => {
        if (!runtime.persistence.getInstance(id)) throw new ConsoleError(404, 'INSTANCE_NOT_FOUND', `实例 ${id} 不存在`)
        return manager.get(id)
    }

    const plugin = (rt: InstanceRuntime, id: string): ConsolePlugin => {
        const found = rt.extension?.consolePlugin?.()
        if (!found || found.id !== id) throw new ConsoleError(404, 'PLUGIN_NOT_FOUND', `插件 ${id} 未接入该实例`)
        return found
    }

    const mutate = async <T>(id: string, fn: (rt: InstanceRuntime) => T): Promise<T> => {
        instance(id)
        return manager.withLock(id, () => {
            const rt = manager.get(id)
            const result = fn(rt)
            manager.saveSnapshot(rt)
            return result
        })
    }

    const route = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
        const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
        const method = req.method ?? 'GET'
        if (parts[0] !== 'api') throw new ConsoleError(404, 'NOT_FOUND', '未知路径')
        if (!authorized(req)) throw new ConsoleError(401, 'UNAUTHORIZED', '需要后台令牌')
        if (method === 'GET' && parts.length === 2 && parts[1] === 'instances') {
            return send(res, 200, runtime.persistence.listInstances().map(item => ({ id: item.id, label: item.label,
                templateId: item.templateId, templateVersion: item.templateVersion, worldId: item.worldId, lastActiveAtWall: item.lastActiveAtWall })))
        }
        if (parts[1] !== 'instances' || !parts[2]) throw new ConsoleError(404, 'NOT_FOUND', '未知路径')
        const id = parts[2]
        const tail = parts.slice(3).join('/')
        if (method === 'GET' && tail === 'semantics') return send(res, 200, semanticsView(instance(id), boundedInt(url.searchParams.get('observations'), 50, 500)))
        if (method === 'GET' && tail === 'memories') {
            const rt = instance(id)
            const tag = url.searchParams.get('tag')
            const q = url.searchParams.get('q')
            const memories = rt.workspace.memory.list({ includeDeleted: url.searchParams.get('deleted') === '1',
                ...(tag ? { tags: [tag] } : {}), ...(q ? { text: q } : {}), limit: boundedInt(url.searchParams.get('limit'), 200, 2000) })
            return send(res, 200, memories)
        }
        if (method === 'POST' && parts[3] === 'memories' && parts[5] === 'delete' && parts.length === 6) {
            const ok = await mutate(id, rt => rt.workspace.deleteMemory(parts[4]!, OWNER_ACTOR))
            if (!ok) throw new ConsoleError(404, 'MEMORY_NOT_FOUND', '记忆不存在或已删除')
            return send(res, 200, { ok })
        }
        if (method === 'GET' && tail === 'memory-review') {
            const status = url.searchParams.get('status')
            if (status && !['pending', 'approved', 'rejected'].includes(status)) throw new ConsoleError(400, 'INVALID_QUERY', 'status 无效')
            return send(res, 200, instance(id).memoryReview.list((status ?? undefined) as 'pending' | undefined).reverse())
        }
        if (method === 'POST' && parts[3] === 'memory-review' && parts.length === 5) {
            const body = await readBody(req)
            if (body.decision !== 'approve' && body.decision !== 'reject') throw new ConsoleError(400, 'INVALID_DECISION', 'decision 必须是 approve 或 reject')
            const decision = body.decision
            return send(res, 200, await mutate(id, rt => rt.memoryReview.decide(parts[4]!, decision, ACTOR_ID)))
        }
        if (method === 'GET' && tail === 'audit') {
            return send(res, 200, instance(id).workspace.audit.tail(boundedInt(url.searchParams.get('limit'), 100, 1000)).reverse())
        }
        if (method === 'GET' && parts[3] === 'plugins' && parts.length === 5) {
            const rt = instance(id)
            const found = plugin(rt, parts[4]!)
            return send(res, 200, { id: found.id, title: found.title, panels: found.panels() })
        }
        if (method === 'POST' && parts[3] === 'plugins' && parts[5] === 'actions' && parts.length === 7) {
            const body = await readBody(req)
            const params = scalarParams(body.params)
            return send(res, 200, await mutate(id, rt => plugin(rt, parts[4]!).act(parts[6]!, params, ACTOR_ID)))
        }
        throw new ConsoleError(404, 'NOT_FOUND', '未知路径')
    }

    const server = createServer((req, res) => {
        void (async () => {
            try {
                // Reject foreign Host headers to block DNS-rebinding access from web pages.
                const hostHeader = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
                if (!LOOPBACK.has(hostHeader)) throw new ConsoleError(403, 'FORBIDDEN_HOST', '只接受本机访问')
                const url = new URL(req.url ?? '/', 'http://127.0.0.1')
                const asset = req.method === 'GET' ? ASSETS[url.pathname] : undefined
                if (asset) {
                    const content = await readFile(join(PUBLIC_DIR, asset.file))
                    res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store',
                        'content-security-policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'",
                        'x-content-type-options': 'nosniff' })
                    res.end(content)
                    return
                }
                await route(req, res, url)
            } catch (error) {
                if (error instanceof ConsoleError) send(res, error.status, { error: { code: error.code, message: error.message } })
                else if (error instanceof SyntaxError) send(res, 400, { error: { code: 'INVALID_JSON', message: 'JSON 格式错误' } })
                else send(res, 409, { error: { code: 'ACTION_FAILED', message: (error as Error).message } })
            }
        })()
    })

    return {
        server,
        listen: () => new Promise((resolve, reject) => {
            server.once('error', reject)
            server.listen(opts.port ?? 8788, host, () => {
                const address = server.address() as AddressInfo
                resolve({ url: `http://${host}:${address.port}` })
            })
        }),
        close: () => new Promise(resolve => server.close(() => resolve())),
    }
}
