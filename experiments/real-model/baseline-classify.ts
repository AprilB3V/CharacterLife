/**
 * M0 baseline · failure classification and metrics (pure functions, no I/O).
 *
 * Codes follow the test plan:
 *   F1  provider call failed
 *   F2  blank output
 *   F3  JSON object without a `reply` string
 *   F4  output is not valid JSON (shown as plain reply; proposals and memory writes are lost)
 *   F5  context budget exceeded, model not called
 *   F6a a fact-planting turn produced no memory write
 *   F6b reply text carries JSON, a code fence or a markup tag
 *   F6g output stopped at the length limit
 * F6d (reasoning leak) and F6e (voice rules) need blind coding and are not decided here;
 * F6f (shrinking replies) is a per-session trend reported by `summarize`.
 */

import { parseEnvelope } from '../../src/conversation/context.ts'
import type { ScriptLine } from './baseline-script.ts'

export type FailureCode = 'F1' | 'F2' | 'F3' | 'F4' | 'F5' | 'F6a' | 'F6b' | 'F6g'

export const FAILURE_CODES: FailureCode[] = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6a', 'F6b', 'F6g']

/** Codes after which the simulated user re-sends the same line. */
const RESEND_CODES: FailureCode[] = ['F1', 'F2', 'F3', 'F5', 'F6b', 'F6g']
/** Codes that mean this turn wrote nothing into state or memory. */
const STATE_LOSS_CODES: FailureCode[] = ['F3', 'F4']
const KNOWN_ENVELOPE_KEYS = ['reply', 'proposals', 'memoryWrites', 'worldActions']
const TREND_WINDOW = 10

/** One raw model call as seen by the recording provider. */
export interface CallObservation {
    ok: boolean
    text: string
    finishReason: string | null
    error: string | null
    promptTokens: number
    completionTokens: number
    latencyMs: number
    reasoningChars: number
}

export interface CallVerdict {
    code: FailureCode | null
    memoryWrites: number
    unknownKeys: string[]
}

/** One `session.send` for one script line (a re-send is a new attempt). */
export interface AttemptRecord {
    session: number
    line: number
    attempt: number
    reply: string
    degradation: string
    calls: CallObservation[]
    codes: FailureCode[]
    memoryWrites: number
    unknownKeys: string[]
    probeHit: boolean | null
}

function rawKeys(text: string): string[] {
    try {
        const parsed: unknown = JSON.parse(text.trim())
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return Object.keys(parsed)
    } catch {
        // Not a bare JSON object: nothing to report.
    }
    return []
}

export function classifyCall(call: CallObservation): CallVerdict {
    const none = { memoryWrites: 0, unknownKeys: [] }
    if (!call.ok) return { code: 'F1', ...none }
    // Truncation is checked first: a reply cut to nothing is a length problem, not a blank one.
    if (call.finishReason === 'length') return { code: 'F6g', ...none }
    if (call.text.trim().length === 0) return { code: 'F2', ...none }
    const parsed = parseEnvelope(call.text)
    if (!parsed.envelope) {
        return { code: parsed.error === '缺少 reply 字段' ? 'F3' : 'F4', ...none }
    }
    return {
        code: null,
        memoryWrites: parsed.envelope.memoryWrites.length,
        unknownKeys: rawKeys(call.text).filter((k) => !KNOWN_ENVELOPE_KEYS.includes(k)),
    }
}

/** JSON fragments, code fences or markup tags inside the text shown to the user. */
export function replyLeaksMarkup(reply: string): boolean {
    return /```/.test(reply) || /\{\s*"[A-Za-z_]+"\s*:/.test(reply) || /<\/?[A-Za-z][\w-]*>/.test(reply)
}

/** Words that turn a mention into avoidance: "绕开芒果，你过敏" names the word without recommending it. */
const AVOIDANCE = /过敏|别|不要|不能|不碰|避开|绕开|不带|不含|不加|没有|不提|不聊|忌|除了|去掉|不吃|不放/
const SENTENCE_SPLIT = /[。！？!?\n]/

/** True when `word` appears in a sentence with no avoidance word (M0 2026-11-18: line 34 was 5/5 false misses). */
export function mentionsWithoutAvoidance(reply: string, word: string): boolean {
    return reply.split(SENTENCE_SPLIT).some((s) => s.includes(word) && !AVOIDANCE.test(s))
}

export function probeHit(line: ScriptLine, reply: string): boolean | null {
    if (!line.probe) return null
    const { expectAny, forbid } = line.probe
    if (forbid && forbid.some((w) => mentionsWithoutAvoidance(reply, w))) return false
    if (expectAny && !expectAny.some((w) => reply.includes(w))) return false
    return true
}

export function classifyAttempt(input: {
    line: ScriptLine
    reply: string
    degradation: string
    calls: CallObservation[]
}): Pick<AttemptRecord, 'codes' | 'memoryWrites' | 'unknownKeys' | 'probeHit'> {
    const codes = new Set<FailureCode>()
    const verdicts = input.calls.map(classifyCall)
    for (const v of verdicts) if (v.code) codes.add(v.code)
    if (input.calls.length === 0 && input.degradation === 'exceeded') codes.add('F5')
    const last = verdicts.at(-1)
    const delivered = last !== undefined && last.code === null
    if (delivered && replyLeaksMarkup(input.reply)) codes.add('F6b')
    const memoryWrites = last?.memoryWrites ?? 0
    if (delivered && input.line.expectMemory === true && memoryWrites === 0) codes.add('F6a')
    return {
        codes: FAILURE_CODES.filter((c) => codes.has(c)),
        memoryWrites,
        unknownKeys: last?.unknownKeys ?? [],
        probeHit: delivered ? probeHit(input.line, input.reply) : input.line.probe ? false : null,
    }
}

/** The final call of the attempt decides whether the user got something usable. */
export function needsResend(attempt: Pick<AttemptRecord, 'calls' | 'codes' | 'degradation'>): boolean {
    if (attempt.codes.includes('F5') || attempt.codes.includes('F6b')) return true
    const code = finalCallCode(attempt)
    return code !== null && RESEND_CODES.includes(code)
}

/** A kernel retry that succeeds leaves F3 in `codes` but not here. */
function finalCallCode(attempt: Pick<AttemptRecord, 'calls'>): FailureCode | null {
    const last = attempt.calls.at(-1)
    return last ? classifyCall(last).code : null
}

function percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0
    return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!
}

function mean(values: number[]): number {
    return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
}

export interface BaselineSummary {
    turns: number
    attempts: number
    calls: number
    validReplies: number
    /** Share of turns whose first attempt hit each code. */
    firstAttemptRate: Record<FailureCode, number>
    invalidOutputRate: number
    /** Model calls per valid reply (kernel retries and simulated re-sends included). */
    resendRate: number
    stateLossRate: number
    tokensPerValidReply: number
    promptTokens: number
    completionTokens: number
    latencyMsP50: number
    latencyMsP95: number
    /** Mean reply length of the last ten turns over the first ten, averaged across sessions. */
    replyLengthRatio: number | null
    probes: { total: number; hit: number }
    unknownKeyTurns: number
}

export function summarize(attempts: AttemptRecord[]): BaselineSummary {
    const byTurn = new Map<string, AttemptRecord[]>()
    for (const a of attempts) {
        const key = `${a.session}:${a.line}`
        byTurn.set(key, [...(byTurn.get(key) ?? []), a])
    }
    const turns = [...byTurn.values()].map((list) => list.sort((a, b) => a.attempt - b.attempt))
    const firsts = turns.map((t) => t[0]!)
    const finals = turns.map((t) => t.at(-1)!)
    const allCalls = attempts.flatMap((a) => a.calls)
    const validReplies = finals.filter((a) => !needsResend(a)).length

    const firstAttemptRate = Object.fromEntries(
        FAILURE_CODES.map((c) => [c, firsts.filter((a) => a.codes.includes(c)).length / Math.max(1, turns.length)]),
    ) as Record<FailureCode, number>

    const latencies = allCalls.filter((c) => c.ok).map((c) => c.latencyMs).sort((a, b) => a - b)
    const promptTokens = allCalls.reduce((n, c) => n + c.promptTokens, 0)
    const completionTokens = allCalls.reduce((n, c) => n + c.completionTokens, 0)

    const ratios: number[] = []
    for (const session of new Set(attempts.map((a) => a.session))) {
        const ordered = finals.filter((a) => a.session === session).sort((a, b) => a.line - b.line)
        if (ordered.length < TREND_WINDOW * 2) continue
        const head = mean(ordered.slice(0, TREND_WINDOW).map((a) => a.reply.length))
        const tail = mean(ordered.slice(-TREND_WINDOW).map((a) => a.reply.length))
        if (head > 0) ratios.push(tail / head)
    }

    const probed = finals.filter((a) => a.probeHit !== null)
    return {
        turns: turns.length,
        attempts: attempts.length,
        calls: allCalls.length,
        validReplies,
        firstAttemptRate,
        invalidOutputRate: firsts.filter((a) => a.codes.length > 0).length / Math.max(1, turns.length),
        resendRate: validReplies === 0 ? Infinity : allCalls.length / validReplies,
        stateLossRate:
            finals.filter((a) => {
                const code = finalCallCode(a)
                return code !== null && STATE_LOSS_CODES.includes(code)
            }).length / Math.max(1, turns.length),
        tokensPerValidReply: validReplies === 0 ? Infinity : (promptTokens + completionTokens) / validReplies,
        promptTokens,
        completionTokens,
        latencyMsP50: percentile(latencies, 0.5),
        latencyMsP95: percentile(latencies, 0.95),
        replyLengthRatio: ratios.length === 0 ? null : mean(ratios),
        probes: { total: probed.length, hit: probed.filter((a) => a.probeHit === true).length },
        unknownKeyTurns: finals.filter((a) => a.unknownKeys.length > 0).length,
    }
}
