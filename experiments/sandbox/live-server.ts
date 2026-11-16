/**
 * Live sandbox: the same character assembly as the text sandbox, but the world is Godot over HTTP.
 *
 * The kernel side is unchanged: AgentCore + WorldService (sandbox catalog, observations on)
 * + WorldBridge + Waker + Mind. TextWorld is never stepped; instead CL-World (Godot) leases
 * actions from `GET /v1/world/actions` and reports results and observations to
 * `POST /v1/world/events`, exactly as TextWorld does in-process.
 *
 * Time runs in real time with a fixed scale (default 1 real second = 1 sim minute).
 * Godot reads the sim time from `nowSim` in every world response.
 *
 * One extra read-only route feeds the HUD:
 *   GET /v1/town/feed?since=<n>   drives, autonomy log records after index n, nowSim
 *
 * Usage:
 *   set CLWORLD_TOKEN=<random, at least 16 chars>
 *   npm run sandbox:live
 *   npm run sandbox:live -- --port 8797 --scale 60
 *   npm run sandbox:live -- --mind deepseek --max-calls 60     (ARK_CODING_API_KEY)
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/types.ts'
import { DeepSeekProvider } from '../../src/conversation/providers/deepseek.ts'
import { createWorldRouter } from '../../src/api/world-routes.ts'
import { AgentHost } from '../../src/kernel/host.ts'
import { LlmMind } from '../../src/kernel/cycle/llm-mind.ts'
import type { Mind } from '../../src/kernel/cycle/mind.ts'
import type { AutonomyLogRecord } from '../../src/kernel/cycle/runner.ts'
import { formatSim } from '../../src/kernel/util/clock.ts'
import { SANDBOX_INSTANCE_ID, SANDBOX_NAMES, SANDBOX_WORLD_ID, createSandbox } from './scenario.ts'

const ARK_CODING_BASE_URL = 'https://ark.cn-beijing.volces.com/api/coding/v3'
const LLM_MODEL = 'deepseek-v4-1-flash'
const TICK_SIM_MS = 60_000
const MAX_BODY_BYTES = 256 * 1024
const MAX_FEED_RECORDS = 200
const RATE_WINDOW_MS = 10_000
const RATE_MAX = 400

interface Args {
    port: number
    scale: number
    seed: number
    mind: 'rule' | 'deepseek'
    maxCalls: number
}

function parseArgs(argv: string[]): Args {
    const args: Args = { port: 8797, scale: 60, seed: 1, mind: 'rule', maxCalls: 0 }
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i]
        const value = argv[i + 1] ?? ''
        switch (key) {
            case '--port': args.port = Number(value); break
            case '--scale': args.scale = Number(value); break
            case '--seed': args.seed = Number(value); break
            case '--max-calls': args.maxCalls = Number(value); break
            case '--mind':
                if (value !== 'rule' && value !== 'deepseek') throw new Error('--mind must be rule | deepseek')
                args.mind = value
                break
            default: throw new Error(`Unknown argument ${key}`)
        }
    }
    for (const [name, n] of Object.entries({ port: args.port, scale: args.scale, seed: args.seed })) {
        if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number`)
    }
    if (args.mind === 'deepseek' && !(args.maxCalls > 0)) {
        throw new Error('--mind deepseek needs --max-calls <n>: the hard cap on model calls.')
    }
    return args
}

/** Hard cap on real model calls; the runner logs the thrown error as a failed wake. */
class CappedProvider implements LLMProvider {
    #inner: LLMProvider
    #max: number
    calls = 0

    constructor(inner: LLMProvider, max: number) {
        this.#inner = inner
        this.#max = max
    }

    get name(): string {
        return this.#inner.name
    }
    get model(): string {
        return this.#inner.model
    }

    async complete(request: LLMRequest): Promise<LLMResponse> {
        if (this.calls >= this.#max) throw new Error(`call cap reached (${this.#max})`)
        this.calls++
        return this.#inner.complete(request)
    }
}

function buildMind(args: Args): Mind | undefined {
    if (args.mind === 'rule') return undefined
    const apiKey = process.env.ARK_CODING_API_KEY?.trim()
    if (!apiKey) throw new Error('Missing ARK_CODING_API_KEY; no real call was made.')
    const provider = new CappedProvider(new DeepSeekProvider({ apiKey, baseUrl: ARK_CODING_BASE_URL, model: LLM_MODEL }), args.maxCalls)
    return new LlmMind({ provider })
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let size = 0
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > MAX_BODY_BYTES) {
                reject(new Error('body too large'))
                req.destroy()
                return
            }
            chunks.push(chunk)
        })
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        req.on('error', reject)
    })
}

function readJson(raw: string): Record<string, unknown> {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be a JSON object')
    return parsed as Record<string, unknown>
}

function json(res: ServerResponse, status: number, payload: unknown): void {
    const body = JSON.stringify(payload)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
    res.end(body)
}

function makeRateLimiter(): (key: string) => boolean {
    const buckets = new Map<string, { start: number; count: number }>()
    return (key) => {
        const now = Date.now()
        const bucket = buckets.get(key)
        if (!bucket || now - bucket.start >= RATE_WINDOW_MS) {
            buckets.set(key, { start: now, count: 1 })
            return true
        }
        bucket.count++
        return bucket.count <= RATE_MAX
    }
}

function bearerMatches(req: IncomingMessage, expected: Buffer): boolean {
    const header = req.headers.authorization
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false
    const digest = createHash('sha256').update(header.slice(7).trim()).digest()
    return digest.length === expected.length && timingSafeEqual(digest, expected)
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2))
    const token = process.env.CLWORLD_TOKEN?.trim() ?? ''
    if (token.length < 16) throw new Error('Set CLWORLD_TOKEN (at least 16 chars) for both this server and Godot.')

    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
    const outDir = join(process.cwd(), 'experiments', 'sandbox', '.data', `live-${args.mind}-${stamp}`)
    mkdirSync(outDir, { recursive: true })
    const logFile = join(outDir, 'log.jsonl')

    const records: AutonomyLogRecord[] = []
    const sb = createSandbox({
        seed: args.seed,
        condition: 'B',
        mind: buildMind(args),
        logger: (record) => {
            records.push(record)
            appendFileSync(logFile, `${JSON.stringify(record)}\n`, 'utf8')
            if (record.type === 'wake') {
                const where = SANDBOX_NAMES[record.situation.location ?? ''] ?? record.situation.location ?? '?'
                process.stdout.write(`${record.clock}  wake @${where} -> ${record.action ?? '(idle)'}  ${record.thought}\n`)
            } else if (record.type === 'outcome') {
                process.stdout.write(`${record.clock}    ${record.action} ${record.status}\n`)
            }
        },
    })

    const checkRate = makeRateLimiter()
    const router = createWorldRouter({
        service: sb.world,
        token,
        devMode: false,
        resolveInstance: (worldId) => (worldId === SANDBOX_WORLD_ID ? SANDBOX_INSTANCE_ID : null),
        readBody,
        readJson,
        json,
        checkRate,
    })
    const tokenDigest = createHash('sha256').update(token).digest()

    // The clock starts only after the world has reported once, so the first wake already
    // knows where the character is (TextWorld sends its opening snapshot the same way).
    let worldConnected = false
    const server = createServer((req, res) => {
        void (async () => {
            try {
                const url = new URL(req.url ?? '/', 'http://127.0.0.1')
                if (url.pathname === '/healthz') {
                    json(res, 200, { ok: true, nowSim: sb.clock.nowSim(), running: worldConnected })
                    return
                }
                if (await router.handle(req, res)) {
                    if (req.method === 'POST' && url.pathname === '/v1/world/events' && res.statusCode === 200) worldConnected = true
                    return
                }
                if (req.method === 'GET' && url.pathname === '/v1/town/feed') {
                    if (!bearerMatches(req, tokenDigest)) {
                        json(res, 401, { error: { code: 'UNAUTHORIZED', message: 'missing or invalid world token' } })
                        return
                    }
                    const since = Math.max(0, Math.floor(Number(url.searchParams.get('since') ?? 0)) || 0)
                    const slice = records.slice(since, since + MAX_FEED_RECORDS)
                    json(res, 200, {
                        nowSim: sb.clock.nowSim(),
                        clock: formatSim(sb.clock.nowSim()),
                        scale: args.scale,
                        running: worldConnected,
                        drives: sb.runner.readDrives(),
                        records: slice,
                        next: since + slice.length,
                    })
                    return
                }
                json(res, 404, { error: { code: 'NOT_FOUND', message: `${req.method} ${url.pathname}` } })
            } catch (err) {
                json(res, 400, { error: { code: 'BAD_REQUEST', message: (err as Error).message } })
            }
        })()
    })
    await new Promise<void>((resolve) => server.listen(args.port, '127.0.0.1', resolve))

    // Real-time loop: one host tick per (TICK_SIM_MS / scale) real milliseconds.
    const host = new AgentHost({ clock: sb.clock, tickMs: TICK_SIM_MS }).addAgent(SANDBOX_INSTANCE_ID, sb.runner)
    const realTickMs = TICK_SIM_MS / args.scale
    let stopping = false
    const loop = async (): Promise<void> => {
        while (!stopping && !worldConnected) await new Promise((resolve) => setTimeout(resolve, 200))
        if (stopping) return
        console.log('World connected; clock started.')
        sb.runner.start()
        while (!stopping) {
            const started = Date.now()
            await host.tick()
            await new Promise((resolve) => setTimeout(resolve, Math.max(0, realTickMs - (Date.now() - started))))
        }
    }
    const shutdown = (): void => {
        stopping = true
        server.close()
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)

    console.log(`Live sandbox on http://127.0.0.1:${args.port}  world=${SANDBOX_WORLD_ID}  mind=${args.mind}  scale=${args.scale}x`)
    console.log(`Log: ${logFile}`)
    await loop()
}

main().catch((err: unknown) => {
    console.error(err)
    process.exitCode = 1
})
