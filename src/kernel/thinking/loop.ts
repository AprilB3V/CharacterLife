/**
 * Thinking loop: think on what was heard, keep thinking while more arrives, then decide.
 *
 * - New input during a thinking step is queued, never interrupts it.
 * - After a step, queued input continues the same thought (not a fresh start), at most
 *   `maxChain` times; then the decision is forced.
 * - If the thinker says the other party has not finished, the loop waits briefly for more.
 * - The decision applies the caller's allowed actions and willingness threshold.
 */
import type { ThinkInput, ThinkRequest, Thinker, ThinkingVocabulary, ThoughtDraft, ThoughtResult } from './types.ts'
import { DEFAULT_TURN_STATES } from './types.ts'
import type { Willingness } from './willingness.ts'

export const DEFAULT_VOCABULARY: ThinkingVocabulary = {
  decisions: ['silent', 'reply', 'ask', 'challenge', 'tease', 'advise'],
  emotions: ['neutral'],
  turns: DEFAULT_TURN_STATES,
  fallbackEmotion: 'neutral',
  silent: 'silent',
  ask: 'ask',
  reply: 'reply',
}

/** Below this confidence a line that needs an answer gets a clarifying question instead. */
export const CLARIFY_BELOW = 0.5

export interface ThinkingLoopOptions {
  thinker: Thinker
  maxChain?: number
  /** How long to wait for more input when the thinker says the other party is still talking. */
  holdMs?: number
  sleep?: (ms: number) => Promise<void>
}

export interface ThinkRunInput {
  inputs: readonly ThinkInput[]
  /** Take everything queued since the run started (or since the last call). */
  drain: () => ThinkInput[]
  build: (inputs: readonly ThinkInput[], previous: ThoughtDraft | null, chainDepth: number) => ThinkRequest
}

export interface ThinkRunResult {
  draft: ThoughtDraft
  /** Every input this run consumed, in order. */
  inputs: ThinkInput[]
  chainDepth: number
  steps: Array<{ chainDepth: number; latencyMs: number; draft: ThoughtDraft }>
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export class ThinkingLoop {
  readonly maxChain: number
  #thinker: Thinker
  #holdMs: number
  #sleep: (ms: number) => Promise<void>

  constructor(opts: ThinkingLoopOptions) {
    this.#thinker = opts.thinker
    this.maxChain = opts.maxChain ?? 3
    this.#holdMs = opts.holdMs ?? 1500
    this.#sleep = opts.sleep ?? defaultSleep
  }

  async run(input: ThinkRunInput): Promise<ThinkRunResult> {
    const consumed: ThinkInput[] = [...input.inputs]
    const steps: ThinkRunResult['steps'] = []
    const step = async (inputs: readonly ThinkInput[], previous: ThoughtDraft | null, chainDepth: number) => {
      const started = Date.now()
      const draft = await this.#thinker.think(input.build(inputs, previous, chainDepth))
      steps.push({ chainDepth, latencyMs: Date.now() - started, draft })
      return draft
    }
    let chainDepth = 0
    let draft = await step(input.inputs, null, chainDepth)
    while (chainDepth < this.maxChain) {
      let more = input.drain()
      if (!more.length && (draft.turn === 'speaking' || draft.turn === 'pausing') && this.#holdMs > 0) {
        // Not finished yet: give the other party a moment before deciding.
        await this.#sleep(this.#holdMs)
        more = input.drain()
      }
      if (!more.length) break
      chainDepth++
      consumed.push(...more)
      draft = await step(more, draft, chainDepth)
    }
    return { draft: { ...draft, chainDepth }, inputs: consumed, chainDepth, steps }
  }
}

export interface DecideContext {
  allowed: readonly string[]
  speakThreshold: number
  willingness: Willingness
  vocabulary: ThinkingVocabulary
  nowSim: number
  addressed: boolean
  events: number
  utterances: number
}

/** Apply the decision rules to the thinker's draft. Pure apart from updating willingness. */
export function decideThought(draft: ThoughtDraft, ctx: DecideContext): ThoughtResult {
  const v = ctx.vocabulary
  const allowed = new Set(ctx.allowed)
  // Being asked needs someone speaking: with events only, a line addressed to someone else in the
  // world (an NPC asking the shopkeeper) must not force her to answer.
  const heardSpeech = ctx.utterances > 0
  const askedMe = draft.turn === 'asking_me' && heardSpeech
  const wants = draft.decision !== v.silent
  const value = ctx.willingness.observe({ addressed: ctx.addressed, question: askedMe, events: ctx.events, utterances: ctx.utterances }, ctx.nowSim)
  const effective = Math.min(1, value + (wants ? ctx.willingness.config.thinkerWants : 0))
  const result = (decision: string, ruling: string): ThoughtResult => ({ ...draft, decision, proposed: draft.decision, ruling, willingness: effective })
  const replyOr = (fallback: string) => allowed.has(v.reply) ? v.reply : fallback

  if (draft.fallback) {
    // Without speech there is nothing to reply to "as before".
    if (!heardSpeech) return result(v.silent, 'thinker unavailable and nobody spoke: stay silent')
    return result(allowed.has(draft.decision) ? draft.decision : replyOr(v.silent), 'thinker unavailable: reply as before')
  }
  // Low confidence only changes a reply she gives anyway into a short question; it never makes her speak.
  const unsure = draft.meantConf < CLARIFY_BELOW && allowed.has(v.ask)
  const clarify = () => result(v.ask, `meantConf ${draft.meantConf.toFixed(2)} below ${CLARIFY_BELOW}: ask to confirm`)
  if (askedMe) {
    if (unsure) return clarify()
    const decision = wants && allowed.has(draft.decision) ? draft.decision : replyOr(v.silent)
    return result(decision, 'asked directly: answer')
  }
  if (!wants) return result(v.silent, 'thinker chose silence')
  if (effective < ctx.speakThreshold) {
    return result(v.silent, `willingness ${effective.toFixed(2)} below threshold ${ctx.speakThreshold.toFixed(2)}`)
  }
  if (unsure) return clarify()
  const decision = allowed.has(draft.decision) ? draft.decision : replyOr(v.silent)
  return result(decision, decision === draft.decision ? 'willing and allowed' : `${draft.decision} not allowed now: ${decision}`)
}
