/**
 * Thinking loop types: listen -> think -> continue thinking -> decide.
 *
 * Model- and role-agnostic. Decision and emotion vocabularies, allowed actions and the
 * speak threshold come from the caller (an engine-layer extension), never from the kernel.
 */

/** One thing the character heard or saw since the last decision. */
export interface ThinkInput {
  kind: 'speech' | 'event'
  text: string
  /** Optional recognition confidence of speech, 0..1. */
  confidence?: number
  /** Provenance (turn ID, world event ID ...). */
  ref?: string
}

export const DEFAULT_TURN_STATES = ['speaking', 'pausing', 'done', 'asking_me', 'self_talk'] as const

/** A note the thinker would like to keep; whether it is stored is decided elsewhere. */
export interface ThoughtNote {
  content: string
  source: string
}

/** Structured output of one thinking step. Free prose is never accepted. */
export interface ThoughtDraft {
  heard: string
  meant: string
  meantConf: number
  turn: string
  decision: string
  emotion: string
  intensity?: 1 | 2 | 3
  innerOS?: string
  /** Why this decision: concrete facts it rests on. */
  reason?: string
  notes?: ThoughtNote[]
  /** Set when the new speech answers an earlier clarification question. */
  clarifies?: { heard: string; meant: string }
  /** How many times this turn was continued. */
  chainDepth: number
  /** True when the thinker failed and the draft is a fallback. */
  fallback?: boolean
}

/** Final thought after the decision rules; `text` is filled once a reply is generated. */
export interface ThoughtResult extends ThoughtDraft {
  /** Decision proposed by the thinker before the rules applied. */
  proposed: string
  /** Why the rules kept or changed the decision. */
  ruling: string
  willingness: number
  text?: string
}

export interface ThinkingVocabulary {
  decisions: readonly string[]
  emotions: readonly string[]
  turns: readonly string[]
  fallbackEmotion: string
  /** The decision meaning "do not speak". */
  silent: string
  /** The decision used to ask a short clarifying question. */
  ask: string
  /** The plain reply decision, used when a proposed decision is not allowed. */
  reply: string
}

/** Per-turn policy from the extension (stage, threshold, role-specific context). */
export interface ThinkingPolicy {
  /** Decisions allowed right now (always includes the silent decision). */
  allowed: readonly string[]
  /** Willingness needed to speak, 0..1; higher means quieter. */
  speakThreshold: number
  /** Role-specific situation for the thinker: stage, stance, game state summary. */
  situation: string
  /** How many fresh world events happened since the last decision. */
  freshEvents?: number
  /** Names the character answers to (direct address raises willingness). */
  names?: readonly string[]
  /** A clarification question waiting for an answer, if any. */
  pendingClarification?: { heard: string; meant: string } | null
  vocabulary?: Partial<ThinkingVocabulary>
}

export interface ThinkRequest {
  inputs: readonly ThinkInput[]
  previous: ThoughtDraft | null
  chainDepth: number
  persona: string
  situation: string
  recent: readonly string[]
  vocabulary: ThinkingVocabulary
  pendingClarification?: { heard: string; meant: string } | null
}

export interface Thinker {
  think(request: ThinkRequest): Promise<ThoughtDraft>
}
