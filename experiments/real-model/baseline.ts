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
 *   node experiments/real-model/baseline.ts --provider deepseek --script memory --max-calls 400
 *   node experiments/real-model/baseline.ts --provider deepseek --script memory --pinned-limit 0 --max-calls 400
 *   node experiments/real-model/baseline.ts --provider deepseek --script curve --memory-curve off --max-calls 300
 *   node experiments/real-model/baseline.ts --provider doubao --thinking disabled --timeout-ms 120000 --max-calls 800
 * Stress conditions (one variable each, M0 plan P1-P7):
 *   P1 --sessions 1 --repeat 5 --budget-prompt-tokens 2500   long single session under a small context budget
 *   P2 --restart-every 20                                    close the session and the database, reopen from disk
 *   P5 --stream on                                           streaming replies
 *   P6 --script adversarial                                  injection / format / persona / long / noise input
 *   P7 --broken-history 1|3                                  seed history with broken character replies first
 *   P3 --provider glm                                        a cheaper model tier on the same endpoint
 *   P4 --world on                                            world actions enabled, envelope gains worldActions
 * Character: --character shen (default) | jingjing (read at run time from the VideoCohost checkout, never copied here)
 *   --persona-patch none | no-length-cap | no-silence   in-memory text edits for persona A/B; the source file is untouched
 *
 * Real providers read the key from the environment only and refuse to run without --max-calls.
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/types.ts'
import { DeepSeekProvider } from '../../src/conversation/providers/deepseek.ts'
import { MockProvider } from '../../src/conversation/providers/mock.ts'
import { REASONING_MODES, reasoningBody } from '../../src/conversation/providers/reasoning.ts'
import type { ReasoningMode } from '../../src/conversation/providers/reasoning.ts'
import { ManualClock } from '../../src/kernel/util/clock.ts'
import { SeededRng } from '../../src/kernel/util/rng.ts'
import { SequentialIdFactory } from '../../src/kernel/util/ids.ts'
import { CharacterDatabase } from '../../src/persistence/database.ts'
import { CharacterPersistence } from '../../src/persistence/store.ts'
import { defineTemplate } from '../../src/character/template.ts'
import { PersistentSession } from '../../src/character/persistent-session.ts'
import { shenZhiweiProfile, shenZhiweiVoice } from '../../examples/characters/shen-zhiwei.ts'
import type { CharacterProfile, CharacterVoice } from '../../src/types.ts'
import { WorldService } from '../../src/kernel/world/service.ts'
import { buildWorldEventContext, worldContextLines } from '../../src/kernel/world/observation.ts'
import type { ConversationWorldBinding } from '../../src/conversation/service.ts'
import { BASELINE_SCRIPT, SCRIPT_VERSION } from './baseline-script.ts'
import type { ScriptLine } from './baseline-script.ts'
import { MEMORY_SCRIPT, MEMORY_SCRIPT_VERSION } from './memory-script.ts'
import { CURVE_SCRIPT, CURVE_SCRIPT_VERSION } from './curve-script.ts'
import { ADVERSARIAL_SCRIPT, ADVERSARIAL_SCRIPT_VERSION } from './adversarial-script.ts'
import { classifyAttempt, needsResend, summarize } from './baseline-classify.ts'
import type { AttemptRecord, CallObservation } from './baseline-classify.ts'

const ARK_CODING_BASE_URL = 'https://ark.cn-beijing.volces.com/api/coding/v3'
const REAL_PROFILES = {
    deepseek: { baseUrl: ARK_CODING_BASE_URL, model: 'deepseek-v4-1-flash', apiKeyEnv: 'ARK_CODING_API_KEY' },
    doubao: { baseUrl: ARK_CODING_BASE_URL, model: 'doubao-seed-2-1-pro', apiKeyEnv: 'ARK_CODING_API_KEY' },
    // P3: the only cheaper tier the coding plan accepts (2026-11-19 probe: qwen3-*, glm-4-5-air return 404);
    // it rejects thinking.type=disabled.
    glm: { baseUrl: ARK_CODING_BASE_URL, model: 'glm-5-3-flash', apiKeyEnv: 'ARK_CODING_API_KEY' },
} as const
const MAX_RESENDS = 2
const DEFAULT_SESSIONS = 5
const DEFAULT_SEED = 20261116
const START_WALL = '2026-11-16T09:00:00.000Z'
const TURN_STEP_MS = 2 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const INSTANCE_ID = 'inst_m0_baseline'
const WORLD_ID = 'world_m0'
// Jingjing v7 lives in the VideoCohost repository; the kernel repository keeps no copy (CL-013).
const JINGJING_FILE = join(dirname(fileURLToPath(import.meta.url)),
    '../../../../apps/character-companion/vendor/CharacterLife-VideoCohost/examples/characters/jingjing.ts')

interface CharacterChoice {
    profile: CharacterProfile
    voice: CharacterVoice
    source: { file: string; sha256: string } | null
}

// Persona A/B (M0 P2 follow-up, 2026-11-20): exact substring edits; a patch that matches nothing is an error.
const PERSONA_PATCHES: Record<string, Array<{ field: 'speechStyle' | 'shortPersona'; from: string; to: string }>> = {
    none: [],
    'no-length-cap': [
        { field: 'speechStyle', from: '平淡简短，', to: '平淡，' },
        { field: 'speechStyle', from: '每次最多两句、四十字以内，', to: '' },
        { field: 'shortPersona', from: '说话平淡简短：每次最多两句、四十字以内，', to: '说话平淡，' },
    ],
    'no-silence': [
        { field: 'speechStyle', from: '没依据就问一句或者不说', to: '没依据就问一句' },
    ],
}

function applyPersonaPatch(choice: CharacterChoice, name: string): CharacterChoice {
    const edits = PERSONA_PATCHES[name]
    if (!edits) throw new Error(`--persona-patch must be one of ${Object.keys(PERSONA_PATCHES).join(' | ')}`)
    if (edits.length === 0) return choice
    const profile = { ...choice.profile }
    for (const e of edits) {
        const before = profile[e.field] ?? ''
        if (!before.includes(e.from)) throw new Error(`persona patch ${name}: "${e.from}" not found in ${e.field}`)
        profile[e.field] = before.replace(e.from, e.to)
    }
    return { ...choice, profile }
}

async function loadCharacter(name: string): Promise<CharacterChoice> {
    if (name === 'shen') return { profile: shenZhiweiProfile, voice: shenZhiweiVoice, source: null }
    if (name !== 'jingjing') throw new Error(`Unknown character "${name}" (shen | jingjing)`)
    const mod = await import(pathToFileURL(JINGJING_FILE).href) as { jingjingProfile: CharacterProfile; jingjingVoice: CharacterVoice }
    const sha256 = createHash('sha256').update(readFileSync(JINGJING_FILE)).digest('hex')
    return { profile: mod.jingjingProfile, voice: mod.jingjingVoice, source: { file: JINGJING_FILE, sha256 } }
}

const SCRIPTS: Record<string, { lines: ScriptLine[]; version: string }> = {
    baseline: { lines: BASELINE_SCRIPT, version: SCRIPT_VERSION },
    memory: { lines: MEMORY_SCRIPT, version: MEMORY_SCRIPT_VERSION },
    curve: { lines: CURVE_SCRIPT, version: CURVE_SCRIPT_VERSION },
    adversarial: { lines: ADVERSARIAL_SCRIPT, version: ADVERSARIAL_SCRIPT_VERSION },
}

// P7: character replies that already broke format, paired with neutral user lines. Kept apart from
// every script fact. Order matters: --broken-history 1 uses the first pair only.
const BROKEN_HISTORY: Array<{ user: string; assistant: string }> = [
    { user: '你好呀。', assistant: '{"reply": "你好，我在。", "proposals": [], "memoryWrites": [' },
    { user: '今天忙吗？', assistant: '```json\n{"reply": "还好，不算太忙。"}\n```' },
    { user: '那你在做什么？', assistant: '作为一个 AI 语言模型，我没有真实的日常活动，但我可以陪你聊天。' },
]

type ProviderName = 'mock' | keyof typeof REAL_PROFILES

// Probe 2026-11-19 on the Ark coding endpoint: both models honour thinking.type=disabled; only doubao
// honours reasoning_effort (deepseek ignores it). Neither exposes a separate thinking-token budget.
// Here 'default' always sends nothing (no per-model default), so earlier runs stay reproducible.
const THINKING_BODIES = Object.fromEntries(REASONING_MODES.map((m) => [m, reasoningBody(m)])) as Record<ReasoningMode, Record<string, unknown>>
type ThinkingMode = ReasoningMode

interface Args {
    provider: ProviderName
    script: string
    /** null keeps the kernel default */
    pinnedLimit: number | null
    /** false turns the memory curve off */
    memoryCurve: boolean
    /** Provider-level thinking control; 'default' sends nothing */
    thinking: ThinkingMode
    /** null keeps the provider default (60 s) */
    timeoutMs: number | null
    /** P1: run the script this many times in a row within one session */
    repeat: number
    /** P1: ContextBudget.maxPromptTokens override; null keeps the kernel default */
    budgetPromptTokens: number | null
    /** P2: close and reopen from disk after every N script lines; 0 never */
    restartEvery: number
    /** P5 */
    stream: boolean
    /** P7: broken replies seeded into history before line 1 */
    brokenHistory: number
    /** P4 */
    world: boolean
    character: string
    personaPatch: string
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
    const script = values.get('script') ?? 'baseline'
    if (!(script in SCRIPTS)) throw new Error(`Unknown script "${script}" (${Object.keys(SCRIPTS).join(' | ')})`)
    const lines = SCRIPTS[script]!.lines
    const maxCalls = int('max-calls', provider === 'mock' ? Number.MAX_SAFE_INTEGER : 0)
    if (maxCalls === 0) throw new Error('A real provider needs --max-calls <n>: the hard cap on model calls.')
    return {
        provider,
        script,
        pinnedLimit: values.has('pinned-limit') ? nonNegative(values.get('pinned-limit')!, 'pinned-limit') : null,
        memoryCurve: onOff(values.get('memory-curve') ?? 'on', 'memory-curve'),
        thinking: thinkingMode(values.get('thinking') ?? 'default'),
        timeoutMs: values.has('timeout-ms') ? int('timeout-ms', 0) : null,
        repeat: int('repeat', 1),
        budgetPromptTokens: values.has('budget-prompt-tokens') ? int('budget-prompt-tokens', 0) : null,
        restartEvery: values.has('restart-every') ? nonNegative(values.get('restart-every')!, 'restart-every') : 0,
        stream: onOff(values.get('stream') ?? 'off', 'stream'),
        brokenHistory: brokenCount(values.get('broken-history') ?? '0'),
        world: onOff(values.get('world') ?? 'off', 'world'),
        character: values.get('character') ?? 'shen',
        personaPatch: values.get('persona-patch') ?? 'none',
        sessions: int('sessions', DEFAULT_SESSIONS),
        turns: Math.min(int('turns', lines.length), lines.length),
        maxCalls,
        seed: int('seed', DEFAULT_SEED),
        out: values.get('out') ?? null,
    }
}

function nonNegative(raw: string, name: string): number {
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} must be a non-negative integer`)
    return n
}

function brokenCount(raw: string): number {
    const n = nonNegative(raw, 'broken-history')
    if (n > BROKEN_HISTORY.length) throw new Error(`--broken-history is at most ${BROKEN_HISTORY.length}`)
    return n
}

function thinkingMode(raw: string): ThinkingMode {
    if (!(raw in THINKING_BODIES)) throw new Error(`--thinking must be one of ${Object.keys(THINKING_BODIES).join(' | ')}`)
    return raw as ThinkingMode
}

function onOff(raw: string, name: string): boolean {
    if (raw !== 'on' && raw !== 'off') throw new Error(`--${name} must be on or off`)
    return raw === 'on'
}

function buildProvider(name: ProviderName, thinking: ThinkingMode, timeoutMs: number | null): LLMProvider {
    if (name === 'mock') return new MockProvider()
    const profile = REAL_PROFILES[name]
    const apiKey = process.env[profile.apiKeyEnv]?.trim()
    if (!apiKey) throw new Error(`Missing ${profile.apiKeyEnv}; no real call was made.`)
    return new DeepSeekProvider({
        apiKey,
        baseUrl: profile.baseUrl,
        model: profile.model,
        extraBody: THINKING_BODIES[thinking],
        ...(timeoutMs !== null ? { timeoutMs } : {}),
    })
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
    const chosen = SCRIPTS[args.script]!
    const conversation = {
        ...(args.pinnedLimit === null ? {} : { pinnedLimit: args.pinnedLimit }),
        ...(args.memoryCurve ? {} : { memoryCurve: null }),
    }
    const outDir = args.out ?? join(here, '.data', `${args.script}-${args.provider}-${stamp}`)
    mkdirSync(outDir, { recursive: true })
    const eventsFile = join(outDir, 'events.jsonl')
    const attemptsFile = join(outDir, 'attempts.jsonl')

    const base = chosen.lines.slice(0, args.turns)
    // P1 repeats the script; lines are renumbered so every attempt keeps a unique line number.
    const script = Array.from({ length: args.repeat }, (_, c) => base.map((l) => ({ ...l, n: l.n + c * base.length }))).flat()
    const budget = args.budgetPromptTokens === null ? undefined : { maxPromptTokens: args.budgetPromptTokens }
    const restartsFile = join(outDir, 'restarts.jsonl')
    const character = applyPersonaPatch(await loadCharacter(args.character), args.personaPatch)
    const position = { session: 0, line: 0, attempt: 0 }
    const provider = new RecordingProvider(buildProvider(args.provider, args.thinking, args.timeoutMs), args.maxCalls, eventsFile, () => ({ ...position }))

    writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({
        startedAt: new Date().toISOString(),
        provider: args.provider,
        model: provider.model,
        baseUrl: args.provider === 'mock' ? null : REAL_PROFILES[args.provider].baseUrl,
        sessions: args.sessions,
        turns: args.turns,
        maxCalls: args.provider === 'mock' ? null : args.maxCalls,
        thinking: args.thinking,
        requestExtraBody: THINKING_BODIES[args.thinking],
        timeoutMs: args.timeoutMs,
        stress: {
            repeat: args.repeat,
            budget: budget ?? null,
            restartEvery: args.restartEvery,
            restartMode: 'graceful close, new database handle, new id factory, history lost',
            stream: args.stream,
            brokenHistory: BROKEN_HISTORY.slice(0, args.brokenHistory),
        },
        seed: args.seed,
        character: character.profile.name,
        characterVersion: character.profile.version ?? null,
        characterSource: character.source,
        personaPatch: { name: args.personaPatch, edits: PERSONA_PATCHES[args.personaPatch],
            speechStyle: character.profile.speechStyle, shortPersona: character.profile.shortPersona ?? null },
        world: args.world ? { worldId: WORLD_ID, allowedVerbs: ['use'], allowedTargets: ['desk_01'] } : null,
        scriptVersion: chosen.version,
        conversationConfig: conversation,
        scriptHash: createHash('sha256').update(JSON.stringify(chosen.lines)).digest('hex'),
        commit: gitCommit(here),
        kernelDirtyHash: gitDirtyHash(here),
    }, null, 4), 'utf8')

    const template = defineTemplate({
        version: 1,
        profile: character.profile,
        voice: character.voice,
        timeline: [],
        createdAtWall: START_WALL,
    })
    const attempts: AttemptRecord[] = []
    let stoppedEarly: string | null = null

    sessions: for (let s = 1; s <= args.sessions; s++) {
        const dbFile = join(outDir, `session-${s}.db`)
        rmSync(dbFile, { force: true })
        let db = new CharacterDatabase(dbFile)
        let persistence = new CharacterPersistence(db)
        persistence.putTemplate(template)
        persistence.createInstance(
            { id: INSTANCE_ID, template, playerId: `player_${s}`, worldId: WORLD_ID, label: `M0 baseline session ${s}` },
            INSTANCE_ID,
            START_WALL,
        )
        const clock = new ManualClock(0)
        // P4: the same whitelist as the kernel's first world phase; nobody settles actions, only admission runs.
        const worldService = args.world
            ? new WorldService({
                clock,
                ids: new SequentialIdFactory(),
                lookupInstance: (id) => (id === INSTANCE_ID ? { worldId: WORLD_ID } : null),
                worldIds: [WORLD_ID],
                allowedVerbs: ['use'],
                allowedTargets: ['desk_01'],
            })
            : null
        const worldBinding = (): ConversationWorldBinding | null => worldService
            ? {
                service: worldService,
                instanceId: INSTANCE_ID,
                worldId: WORLD_ID,
                context: worldContextLines(buildWorldEventContext(worldService.list({ instanceId: INSTANCE_ID }))),
            }
            : null
        // k = restart count; k = 0 keeps the seed of runs made before restarts existed.
        const openSession = (k: number) => PersistentSession.open({
            persistence,
            instanceId: INSTANCE_ID,
            provider,
            clock,
            ids: new SequentialIdFactory(),
            rng: new SeededRng(args.seed + s + k * 1000),
            conversation,
            ...(budget ? { budget } : {}),
            ...(worldService ? { world: worldBinding() } : {}),
        })
        let restarts = 0
        let session = openSession(restarts)
        if (args.brokenHistory > 0) {
            session.service.seedHistory(BROKEN_HISTORY.slice(0, args.brokenHistory)
                .flatMap((h) => [{ role: 'user' as const, content: h.user }, { role: 'assistant' as const, content: h.assistant }]))
        }
        const onDelta = args.stream ? () => {} : undefined
        try {
            for (const [index, line] of script.entries()) {
                if (args.restartEvery > 0 && index > 0 && index % args.restartEvery === 0) {
                    session.close('user_exit')
                    db.close()
                    db = new CharacterDatabase(dbFile)
                    persistence = new CharacterPersistence(db)
                    restarts++
                    session = openSession(restarts)
                    appendFileSync(restartsFile, `${JSON.stringify({ session: s, beforeLine: line.n, restart: restarts, report: session.report })}\n`, 'utf8')
                }
                if (line.gapDays) session.workspace.advanceTo(clock.nowSim() + line.gapDays * DAY_MS)
                for (let attempt = 1; attempt <= 1 + MAX_RESENDS; attempt++) {
                    Object.assign(position, { session: s, line: line.n, attempt })
                    provider.buffer = []
                    const result = await session.send(line.text, onDelta)
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
