/**
 * M0 baseline · how often does the kernel "lose format" under a real model, and what does it cost?
 *
 * Each session replays the fixed 60-line user script against a fresh instance with kernel
 * defaults (non-streaming, world actions off). Every raw model call is appended to
 * `events.jsonl`; every attempt is classified into F1-F6 and appended to `attempts.jsonl`.
 * A failed reply makes the simulated user re-send the same line, at most twice.
 *
 * Usage:
 *   node experiments/real-model/baseline.ts --provider mock
 *   node experiments/real-model/baseline.ts --provider deepseek --sessions 1 --turns 10 --max-calls 40
 *   node experiments/real-model/baseline.ts --provider doubao --max-calls 800
 *
 * Real providers read the key from the environment only and refuse to run without --max-calls.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/types.ts'
import { DeepSeekProvider } from '../../src/conversation/providers/deepseek.ts'
import { MockProvider } from '../../src/conversation/providers/mock.ts'
import { ManualClock } from '../../src/kernel/util/clock.ts'
import { SeededRng } from '../../src/kernel/util/rng.ts'
import { SequentialIdFactory } from '../../src/kernel/util/ids.ts'
import { CharacterDatabase } from '../../src/persistence/database.ts'
import { CharacterPersistence } from '../../src/persistence/store.ts'
import { defineTemplate } from '../../src/character/template.ts'
import { PersistentSession } from '../../src/character/persistent-session.ts'
import { shenZhiweiProfile, shenZhiweiVoice } from '../../examples/characters/shen-zhiwei.ts'
import { BASELINE_SCRIPT, SCRIPT_VERSION } from './baseline-script.ts'
import { classifyAttempt, needsResend, summarize } from './baseline-classify.ts'
import type { AttemptRecord, CallObservation } from './baseline-classify.ts'

const ARK_CODING_BASE_URL = 'https://ark.cn-beijing.volces.com/api/coding/v3'
const REAL_PROFILES = {
    deepseek: { baseUrl: ARK_CODING_BASE_URL, model: 'deepseek-v4-1-flash', apiKeyEnv: 'ARK_CODING_API_KEY' },
    doubao: { baseUrl: ARK_CODING_BASE_URL, model: 'doubao-seed-2-1-pro', apiKeyEnv: 'ARK_CODING_API_KEY' },
} as const
const MAX_RESENDS = 2
const DEFAULT_SESSIONS = 5
const DEFAULT_SEED = 20261116
const START_WALL = '2026-11-16T09:00:00.000Z'
const TURN_STEP_MS = 2 * 60 * 1000
const INSTANCE_ID = 'inst_m0_baseline'

type ProviderName = 'mock' | keyof typeof REAL_PROFILES

interface Args {
    provider: ProviderName
    sessions: number
    turns: number
    maxCalls: number
    seed: number
    out: string | null
}

function parseArgs(argv: string[]): Args {
    const values = new Map<string, string>()
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i]
        const value = argv[i + 1]
        if (!key?.startsWith('--') || value === undefined) throw new Error(`Bad argument near "${key ?? ''}"`)
        values.set(key.slice(2), value)
    }
    const provider = (values.get('provider') ?? 'mock') as ProviderName
    if (provider !== 'mock' && !(provider in REAL_PROFILES)) {
        throw new Error(`Unknown provider "${provider}" (mock | ${Object.keys(REAL_PROFILES).join(' | ')})`)
    }
    const int = (name: string, fallback: number): number => {
        const raw = values.get(name)
        if (raw === undefined) return fallback
        const n = Number(raw)
        if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive integer`)
        return n
    }
    const maxCalls = int('max-calls', provider === 'mock' ? Number.MAX_SAFE_INTEGER : 0)
    if (maxCalls === 0) throw new Error('A real provider needs --max-calls <n>: the hard cap on model calls.')
    return {
        provider,
        sessions: int('sessions', DEFAULT_SESSIONS),
        turns: Math.min(int('turns', BASELINE_SCRIPT.length), BASELINE_SCRIPT.length),
        maxCalls,
        seed: int('seed', DEFAULT_SEED),
        out: values.get('out') ?? null,
    }
}

function buildProvider(name: ProviderName): LLMProvider {
    if (name === 'mock') return new MockProvider()
    const profile = REAL_PROFILES[name]
    const apiKey = process.env[profile.apiKeyEnv]?.trim()
    if (!apiKey) throw new Error(`Missing ${profile.apiKeyEnv}; no real call was made.`)
    return new DeepSeekProvider({ apiKey, baseUrl: profile.baseUrl, model: profile.model })
}

class BudgetExceededError extends Error {}

/** Counts, caps and records every raw call; the kernel never sees a difference. */
class RecordingProvider implements LLMProvider {
    #inner: LLMProvider
    #maxCalls: number
    #eventsFile: string
    #tag: () => Record<string, number>
    callCount = 0
    buffer: CallObservation[] = []

    constructor(inner: LLMProvider, maxCalls: number, eventsFile: string, tag: () => Record<string, number>) {
        this.#inner = inner
        this.#maxCalls = maxCalls
        this.#eventsFile = eventsFile
        this.#tag = tag
    }

    get name(): string {
        return this.#inner.name
    }
    get model(): string {
        return this.#inner.model
    }

    async complete(request: LLMRequest): Promise<LLMResponse> {
        if (this.callCount >= this.#maxCalls) throw new BudgetExceededError(`Call cap reached (${this.#maxCalls})`)
        this.callCount++
        const started = Date.now()
        try {
            const response = await this.#inner.complete(request)
            this.#record({
                ok: true,
                text: response.text,
                finishReason: response.finishReason ?? null,
                error: null,
                promptTokens: response.usage?.promptTokens ?? 0,
                completionTokens: response.usage?.completionTokens ?? 0,
                latencyMs: response.latencyMs,
                reasoningChars: response.reasoningChars ?? 0,
            }, response.model)
            return response
        } catch (err) {
            this.#record({
                ok: false,
                text: '',
                finishReason: null,
                error: (err as Error).message.slice(0, 400),
                promptTokens: 0,
                completionTokens: 0,
                latencyMs: Date.now() - started,
                reasoningChars: 0,
            }, this.#inner.model)
            throw err
        }
    }

    #record(call: CallObservation, model: string): void {
        this.buffer.push(call)
        appendFileSync(this.#eventsFile, `${JSON.stringify({ call: this.callCount, ...this.#tag(), model, ...call })}\n`, 'utf8')
    }
}

function gitCommit(cwd: string): string | null {
    try {
        return execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()
    } catch {
        return null
    }
}

/** Hash of uncommitted kernel changes (tracked diff + untracked files), so runs on one commit stay distinguishable. */
function gitDirtyHash(cwd: string): string | null {
    try {
        const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' })
        const diff = git('diff', 'HEAD', '--', ':(top)src')
        const untracked = git('ls-files', '--others', '--exclude-standard', '--full-name', '--', ':(top)src')
            .split('\n').filter(Boolean).sort()
        if (diff.length === 0 && untracked.length === 0) return null
        const root = git('rev-parse', '--show-toplevel').trim()
        const hash = createHash('sha256').update(diff)
        for (const file of untracked) hash.update(`\0${file}\0`).update(readFileSync(join(root, file)))
        return hash.digest('hex').slice(0, 16)
    } catch {
        return null
    }
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2))
    const here = dirname(fileURLToPath(import.meta.url))
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
    const outDir = args.out ?? join(here, '.data', `baseline-${args.provider}-${stamp}`)
    mkdirSync(outDir, { recursive: true })
    const eventsFile = join(outDir, 'events.jsonl')
    const attemptsFile = join(outDir, 'attempts.jsonl')

    const script = BASELINE_SCRIPT.slice(0, args.turns)
    const position = { session: 0, line: 0, attempt: 0 }
    const provider = new RecordingProvider(buildProvider(args.provider), args.maxCalls, eventsFile, () => ({ ...position }))

    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({
        startedAt: new Date().toISOString(),
        provider: args.provider,
        model: provider.model,
        baseUrl: args.provider === 'mock' ? null : REAL_PROFILES[args.provider].baseUrl,
        sessions: args.sessions,
        turns: args.turns,
        maxCalls: args.provider === 'mock' ? null : args.maxCalls,
        seed: args.seed,
        character: shenZhiweiProfile.name,
        scriptVersion: SCRIPT_VERSION,
        scriptHash: createHash('sha256').update(JSON.stringify(BASELINE_SCRIPT)).digest('hex'),
        commit: gitCommit(here),
        kernelDirtyHash: gitDirtyHash(here),
    }, null, 4), 'utf8')

    const template = defineTemplate({
        version: 1,
        profile: shenZhiweiProfile,
        voice: shenZhiweiVoice,
        timeline: [],
        createdAtWall: START_WALL,
    })
    const attempts: AttemptRecord[] = []
    let stoppedEarly: string | null = null

    sessions: for (let s = 1; s <= args.sessions; s++) {
        const dbFile = join(outDir, `session-${s}.db`)
        rmSync(dbFile, { force: true })
        const db = new CharacterDatabase(dbFile)
        const persistence = new CharacterPersistence(db)
        persistence.putTemplate(template)
        persistence.createInstance(
            { id: INSTANCE_ID, template, playerId: `player_${s}`, worldId: 'world_m0', label: `M0 baseline session ${s}` },
            INSTANCE_ID,
            START_WALL,
        )
        const clock = new ManualClock(0)
        const session = PersistentSession.open({
            persistence,
            instanceId: INSTANCE_ID,
            provider,
            clock,
            ids: new SequentialIdFactory(),
            rng: new SeededRng(args.seed + s),
        })
        try {
            for (const line of script) {
                for (let attempt = 1; attempt <= 1 + MAX_RESENDS; attempt++) {
                    Object.assign(position, { session: s, line: line.n, attempt })
                    provider.buffer = []
                    const result = await session.send(line.text)
                    const calls = provider.buffer
                    const degradation = result.contextUsage?.degradation ?? 'none'
                    const record: AttemptRecord = {
                        session: s,
                        line: line.n,
                        attempt,
                        reply: result.reply,
                        degradation,
                        calls,
                        ...classifyAttempt({ line, reply: result.reply, degradation, calls }),
                    }
                    attempts.push(record)
                    appendFileSync(attemptsFile, `${JSON.stringify(record)}\n`, 'utf8')
                    // The kernel swallows provider errors, so the cap is checked here.
                    if (provider.callCount >= args.maxCalls) {
                        stoppedEarly = `call cap ${args.maxCalls} reached at session ${s}, line ${line.n}`
                        break sessions
                    }
                    if (!needsResend(record)) break
                }
                session.workspace.advanceTo(clock.nowSim() + TURN_STEP_MS)
            }
            process.stderr.write(`session ${s}/${args.sessions} done, ${provider.callCount} calls so far\n`)
        } finally {
            session.close('user_exit')
            db.close()
        }
    }

    const summary = { stoppedEarly, ...summarize(attempts) }
    writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 4), 'utf8')
    console.log(JSON.stringify(summary, null, 4))
    console.log(`\nOutput: ${outDir}`)
    if (stoppedEarly) process.exitCode = 3
}

await main()
