/**
 * Willingness to speak (after MaiBot's reply willingness).
 *
 * Rises when the character is addressed, asked, or when world events happen; drops right
 * after she speaks; drifts back to a base level over time. Only crossing the caller's
 * threshold lets her speak. Staying silent is a normal, recorded decision.
 */

export interface WillingnessConfig {
  base: number
  /** Drift back toward `base`, per minute of sim time. */
  decayPerMinute: number
  addressed: number
  question: number
  /** Per fresh world event. */
  event: number
  /** Per utterance heard; lets several unanswered lines add up. */
  utterance: number
  /** Added for this decision when the thinker itself wants to speak. */
  thinkerWants: number
  /** Applied right after she speaks. */
  afterSpeaking: number
}

export const DEFAULT_WILLINGNESS: WillingnessConfig = {
  base: 0.3,
  decayPerMinute: 0.2,
  addressed: 0.4,
  question: 0.3,
  event: 0.15,
  utterance: 0.05,
  thinkerWants: 0.2,
  afterSpeaking: -0.3,
}

const clamp = (value: number) => Math.min(1, Math.max(0, value))

export class Willingness {
  readonly config: WillingnessConfig
  #value: number
  #atSim: number | null = null

  constructor(config: Partial<WillingnessConfig> = {}) {
    this.config = { ...DEFAULT_WILLINGNESS, ...config }
    this.#value = this.config.base
  }

  /** Current value at `nowSim`, after drifting toward the base. */
  value(nowSim: number): number {
    if (this.#atSim === null) return this.#value
    const minutes = Math.max(0, nowSim - this.#atSim) / 60000
    const drift = this.config.decayPerMinute * minutes
    const gap = this.config.base - this.#value
    return clamp(Math.abs(gap) <= drift ? this.config.base : this.#value + Math.sign(gap) * drift)
  }

  /** Account for what was heard; returns the value for this decision. */
  observe(signals: { addressed: boolean; question: boolean; events: number; utterances: number }, nowSim: number): number {
    let next = this.value(nowSim)
    if (signals.addressed) next += this.config.addressed
    if (signals.question) next += this.config.question
    next += this.config.event * signals.events + this.config.utterance * signals.utterances
    this.#value = clamp(next)
    this.#atSim = nowSim
    return this.#value
  }

  /** She just spoke. */
  spoke(nowSim: number): void {
    this.#value = clamp(this.value(nowSim) + this.config.afterSpeaking)
    this.#atSim = nowSim
  }
}
