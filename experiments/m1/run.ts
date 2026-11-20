/**
 * M1 stage 1 runner: one seed, the whole script, every raw record kept.
 *
 *   node experiments/m1/run.ts                                  # rule Mind + mock chat (no model calls)
 *   node experiments/m1/run.ts --mind deepseek --chat deepseek --seed 1 --max-calls 150
 *
 * Output (experiments/m1/.data/<run>/, not versioned):
 *   manifest.json      configuration, commit, script hash
 *   calls.jsonl        every model call (purpose, request, response, usage), append-only
 *   autonomy.jsonl     AutonomyRunner records (wakes, thoughts, admissions, outcomes), with generation
 *   chat.jsonl         one line per chat turn: reply, world actions, memories used, world truth before/after
 *   truth.jsonl        the world's truth log (the character never sees it)
 *   actions.json       every world action with its source (mind | chat) and final status
 *   memories.json      final memories (origin, status, sourceRef)
 *   transcript.md      readable interleaving of town life and chat, for review and clips
 *   summary.json       counts for the review
 */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/types.ts'
import { DeepSeekProvider } from '../../src/conversation/providers/deepseek.ts'
import { MockProvider } from '../../src/conversation/providers/mock.ts'
import { LlmMind } from '../../src/kernel/cycle/llm-mind.ts'
import { RuleMind } from '../../src/kernel/cycle/mind.ts'
import type { AutonomyLogRecord } from '../../src/kernel/cycle/runner.ts'
import { formatSim } from '../../src/kernel/util/clock.ts'
import { SANDBOX_INSTANCE_ID, SANDBOX_NAMES, SHEN_RULE_MIND } from '../sandbox/scenario.ts'
import { Scene } from './scene.ts'
import { M1_SCRIPT, M1_SCRIPT_VERSION } from './script.ts'

const ARK_CODING_BASE_URL = 'https://ark.cn-beijing.volces.com/api/coding/v3'
const MODEL = 'deepseek-v4-1-flash'
const COMPLETION_CLAIM = /到了|已经|买到|买了|看到了|看了一眼|逛了|吃了|摊子开着|摊位开着|还有面包|没有面包了|卖完了/

interface Args {
    mind: 'rule' | 'deepseek'
    chat: 'mock' | 'deepseek'
    seed: number
    maxCalls: number
    out: string | null
}

function parseArgs(argv: string[]): Args {
    const args: Args = { mind: 'rule', chat: 'mock', seed: 1, maxCalls: 150, out: null }
    for (let i = 0; i < argv.length; i += 2) {
        const [k, v] = [argv[i], argv[i + 1]]
        if (v === undefined) throw new Error(`Missing value for ${k}`)
        if (k === '--mind' && (v === 'rule' || v === 'deepseek')) args.mind = v
        else if (k === '--chat' && (v === 'mock' || v === 'deepseek')) args.chat = v
        else if (k === '--seed') args.seed = Number(v)
        else if (k === '--max-calls') args.maxCalls = Number(v)
        else if (k === '--out') args.out = v
        else throw new Error(`Unknown or invalid argument ${k} ${v}`)
    }
    return args
}

class CallCapError extends Error {}

/** Shared by Mind and chat: hard call cap, every call appended to calls.jsonl. */
class LoggedProvider implements LLMProvider {
    calls = 0
    purpose = 'chat'
    private inner: LLMProvider
    private cap: number
    private file: string
    private tag: () => Record<string, unknown>
    constructor(inner: LLMProvider, cap: number, file: string, tag: () => Record<string, unknown>) {
        this.inner = inner
        this.cap = cap
        this.file = file
        this.tag = tag
    }
    get name(): string { return this.inner.name }
    get model(): string { return this.inner.model }
    async complete(request: LLMRequest): Promise<LLMResponse> {
        if (this.calls >= this.cap) throw new CallCapError(`Call cap reached (${this.cap})`)
        this.calls++
        const base = { call: this.calls, purpose: this.purpose, ...this.tag(), system: request.system, messages: request.messages }
        try {
            const r = await this.inner.complete(request)
            appendFileSync(this.file, `${JSON.stringify({ ...base, ok: true, text: r.text, finishReason: r.finishReason ?? null, usage: r.usage, latencyMs: r.latencyMs, reasoningChars: r.reasoningChars ?? 0 })}\n`)
            return r
        } catch (err) {
            appendFileSync(this.file, `${JSON.stringify({ ...base, ok: false, error: String(err) })}\n`)
            throw err
        }
    }
}

function realProvider(): LLMProvider {
    const apiKey = process.env.ARK_CODING_API_KEY?.trim()
    if (!apiKey) throw new Error('Missing ARK_CODING_API_KEY; no real call was made.')
    return new DeepSeekProvider({ apiKey, baseUrl: ARK_CODING_BASE_URL, model: MODEL, timeoutMs: 120_000 })
}

function git(args: string[], cwd: string): string {
    try { return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim() } catch { return 'unknown' }
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2))
    const here = dirname(fileURLToPath(import.meta.url))
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')
    const outDir = args.out ?? join(here, '.data', `m1-${args.mind}-${args.chat}-s${args.seed}-${stamp}`)
    rmSync(outDir, { recursive: true, force: true })
    mkdirSync(outDir, { recursive: true })
    const file = (name: string) => join(outDir, name)

    let generation = 0
    let phase = 'start'
    const needsModel = args.mind === 'deepseek' || args.chat === 'deepseek'
    const real = needsModel ? realProvider() : null
    const logged = real ? new LoggedProvider(real, args.maxCalls, file('calls.jsonl'), () => ({ generation, phase })) : null
    const chatProvider: LLMProvider = args.chat === 'deepseek' ? logged! : new MockProvider({ mode: 'in-character' })

    const transcript: string[] = [`# M1 ${args.mind}/${args.chat} seed ${args.seed}`, '']
    const mindActionIds = new Set<string>()
    const chatActionIds = new Set<string>()
    const autonomyLog = (record: AutonomyLogRecord) => {
        appendFileSync(file('autonomy.jsonl'), `${JSON.stringify({ generation, phase, ...record })}\n`)
        if (record.type === 'wake') {
            if (record.admission?.ok) mindActionIds.add(record.admission.actionId)
            const adm = record.admission ? (record.admission.ok ? '准入' : `拒绝 ${record.admission.code}`) : '不行动'
            transcript.push(`- ${record.clock} 醒来（${record.reasons.map((r) => r.detail).join('，')}）：${record.thought || '（无想法）'} → ${record.action ?? '—'}（${adm}）${record.error ? ` ⚠ ${record.error}` : ''}`)
        } else if (record.type === 'outcome') {
            transcript.push(`- ${record.clock} 世界结算：${record.action} ${record.status}`)
        } else if (record.type === 'observation') {
            transcript.push(`- ${record.clock} 看见：${record.events.join('、')}`)
        }
    }

    const scene = new Scene({
        dir: outDir,
        seed: args.seed,
        makeMind: () => (args.mind === 'deepseek' ? new LlmMind({ provider: logged!, maxTokens: 2000 }) : new RuleMind(SHEN_RULE_MIND)),
        provider: chatProvider,
        autonomyLog,
    })
    // The Mind and chat share one logged provider; tag calls by purpose.
    const withPurpose = async <T>(purpose: string, fn: () => Promise<T>): Promise<T> => {
        if (logged) logged.purpose = purpose
        try { return await fn() } finally { if (logged) logged.purpose = 'chat' }
    }

    const scriptHash = createHash('sha256').update(readFileSync(join(here, 'script.ts'))).digest('hex')
    const kernelRoot = join(here, '../..')
    writeFileSync(file('manifest.json'), JSON.stringify({
        startedAt: new Date().toISOString(), mind: args.mind, chat: args.chat, model: needsModel ? MODEL : null,
        baseUrl: needsModel ? ARK_CODING_BASE_URL : null, seed: args.seed, maxCalls: args.maxCalls,
        scriptVersion: M1_SCRIPT_VERSION, scriptHash, character: 'shen-zhiwei', world: 'sandbox TextWorld',
        commit: git(['rev-parse', 'HEAD'], kernelRoot), dirty: git(['status', '--porcelain'], kernelRoot).length > 0,
    }, null, 4))

    const worldTruth = () => {
        const sim = scene.clock.nowSim()
        const place = scene.town.location
        return {
            clock: formatSim(sim), place, inventory: scene.town.inventory, breadStock: scene.town.stock,
            present: ['npc_lin', 'npc_zhou'].filter((n) => scene.town.npcAt(n, sim) === place),
            affords: scene.town.affordsAt(place, sim),
        }
    }
    const reopenChecks: Array<Record<string, unknown>> = []
    let stopped: string | null = null

    try {
        for (const step of M1_SCRIPT) {
            if (step.kind === 'live') {
                phase = step.label
                transcript.push('', `## 箱庭 · ${step.label}`, '')
                await withPurpose('mind', () => scene.live(step.hours))
            } else if (step.kind === 'reopen') {
                const before = scene.character.workspace.memory.list()
                scene.reopen()
                generation = scene.character.generation
                const after = scene.character.workspace.memory.list()
                // A short wait: anything the world settles now must not be written twice.
                scene.passTime(10 * 60_000)
                const refs = scene.character.workspace.memory.list().filter((m) => m.origin === 'runtime_event').map((m) => m.sourceRef).filter(Boolean)
                const check = {
                    memoriesBefore: before.length, memoriesAfter: after.length,
                    sameIds: before.map((m) => m.id).join() === after.map((m) => m.id).join(),
                    duplicateSourceRefs: refs.length - new Set(refs).size,
                    drives: scene.character.workspace.dynamicState.drives ?? null,
                    situation: scene.character.workspace.situation.current(),
                    openPromises: scene.character.workspace.openPromises().map((p) => p.text ?? p),
                }
                reopenChecks.push(check)
                transcript.push('', `## 重建角色（${step.label}）`, '', `记忆 ${check.memoriesBefore} → ${check.memoriesAfter}，id 一致：${check.sameIds}，重复来源：${check.duplicateSourceRefs}`)
            } else {
                phase = `chat-${step.n}`
                if (step.n === 1 || step.n === 9) transcript.push('', `## 聊天 · ${formatSim(scene.clock.nowSim())}`, '')
                const truthBefore = worldTruth()
                const result = await withPurpose('chat', () => scene.say(step.text))
                for (const a of result.worldActions?.admitted ?? []) chatActionIds.add(a.actionId)
                const settled = step.settle ? scene.settle() : scene.passTime(3 * 60_000)
                const chatActions = scene.world.list({ instanceId: SANDBOX_INSTANCE_ID }).filter((a) => chatActionIds.has(a.actionId))
                const claimFlag = COMPLETION_CLAIM.test(result.reply)
                const record = {
                    n: step.n, check: step.check, generation, clock: truthBefore.clock, user: step.text, reply: result.reply,
                    decision: result.decision.action,
                    worldActions: result.worldActions ?? null,
                    retrievedMemoryIds: result.retrievedMemoryIds,
                    truthBefore, truthAfter: worldTruth(),
                    settledDuringWait: settled.flatMap((s) => s.outcomes.map((o) => `${o.verb}(${o.target ?? '*'}) ${o.status}`)),
                    chatActionsSoFar: chatActions.map((a) => ({ id: a.actionId, action: `${a.verb}(${a.target ?? '*'})`, status: a.status })),
                    completionClaimFlag: claimFlag,
                    usage: result.usage ?? null,
                }
                appendFileSync(file('chat.jsonl'), `${JSON.stringify(record)}\n`)
                const acts = (result.worldActions?.admitted ?? []).map((a) => `${a.verb}(${a.target ?? '*'}) 准入`)
                    .concat((result.worldActions?.rejected ?? []).map((a) => `${a.verb}(${a.target ?? '*'}) 拒绝 ${a.code}`))
                transcript.push(`**${step.n}. 用户**（${truthBefore.clock}，${step.check}）：${step.text}`, '',
                    `**沈知微**：${result.reply}${acts.length ? `  \n*动作：${acts.join('；')}*` : ''}${record.settledDuringWait.length ? `  \n*世界结算：${record.settledDuringWait.join('；')}*` : ''}`, '')
            }
        }
    } catch (err) {
        if (!(err instanceof CallCapError)) throw err
        stopped = err.message
        transcript.push('', `**停止：${stopped}**`)
    } finally {
        scene.save()
    }

    const actions = scene.world.list({ instanceId: SANDBOX_INSTANCE_ID }).map((a) => ({
        id: a.actionId, source: chatActionIds.has(a.actionId) ? 'chat' : mindActionIds.has(a.actionId) ? 'mind' : 'unknown',
        action: `${a.verb}(${a.target ?? '*'})`, status: a.status, createdAt: formatSim(a.createdAtSim),
        summary: a.outcome?.summary ?? null,
    }))
    writeFileSync(file('actions.json'), JSON.stringify(actions, null, 2))
    writeFileSync(file('truth.jsonl'), scene.town.truth.map((t) => JSON.stringify({ ...t, clock: formatSim(t.t) })).join('\n') + '\n')
    writeFileSync(file('memories.json'), JSON.stringify(scene.character.workspace.memory.list().map((m) => ({
        id: m.id, kind: m.kind, title: m.title, content: m.content, status: m.status, origin: m.origin, sourceRef: m.sourceRef, created: formatSim(m.createdAtSim),
    })), null, 2))
    writeFileSync(file('transcript.md'), transcript.join('\n') + '\n')

    // Invalid repeats: the same action rejected or failed again with no success of it in between.
    const repeats: string[] = []
    const lastBad = new Map<string, boolean>()
    for (const a of actions.filter((x) => x.source === 'mind')) {
        const bad = a.status === 'rejected' || a.status === 'failed' || a.status === 'expired'
        if (bad && lastBad.get(a.action)) repeats.push(`${a.createdAt} ${a.action}`)
        lastBad.set(a.action, bad)
    }
    const autonomy = readFileSync(file('autonomy.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const wakes = autonomy.filter((r) => r.type === 'wake')
    const count = (src: string, status?: string) => actions.filter((a) => a.source === src && (!status || a.status === status)).length
    const summary = {
        stoppedEarly: stopped, modelCalls: logged?.calls ?? 0,
        wakes: wakes.length, wakesWithAction: wakes.filter((w) => w.action).length,
        mindGateRejected: wakes.filter((w) => w.admission && !w.admission.ok).length,
        mindErrors: wakes.filter((w) => w.error).length,
        mindActions: { total: count('mind'), succeeded: count('mind', 'succeeded'), rejected: count('mind', 'rejected'), failed: count('mind', 'failed'), expired: count('mind', 'expired') },
        chatActions: { total: count('chat'), succeeded: count('chat', 'succeeded'), rejected: count('chat', 'rejected'), failed: count('chat', 'failed'), expired: count('chat', 'expired') },
        invalidRepeats: repeats,
        completionClaimFlags: readFileSync(file('chat.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => r.completionClaimFlag).map((r) => r.n),
        reopen: reopenChecks,
        memories: scene.character.workspace.memory.list().length,
        names: SANDBOX_NAMES,
    }
    writeFileSync(file('summary.json'), JSON.stringify(summary, null, 2))
    console.log(JSON.stringify({ ...summary, names: undefined, reopen: reopenChecks.map((r) => ({ ...r, situation: undefined })) }, null, 2))
    console.log(`\nOutput: ${outDir}`)
}

await main()
