/**
 * Per-model reasoning (thinking) control for OpenAI-compatible endpoints.
 *
 * Modes map to request-body fields; 'default' sends nothing, so an endpoint that does not know
 * these fields is never affected. Verified defaults come from M0 measurements and only claim
 * better envelope stability under the kernel's 2000-token output cap, not better model quality.
 */

export const REASONING_MODES = ['default', 'disabled', 'none', 'low', 'minimal'] as const
export type ReasoningMode = typeof REASONING_MODES[number]

// Probe 2026-11-19, Ark coding endpoint: doubao and deepseek honour thinking.type=disabled; only doubao
// honours reasoning_effort; glm rejects disabled but honours reasoning_effort=low; 'auto' is a 400 everywhere.
const REASONING_BODIES: Record<ReasoningMode, Record<string, unknown>> = {
    default: {},
    disabled: { thinking: { type: 'disabled' } },
    low: { reasoning_effort: 'low' },
    minimal: { reasoning_effort: 'minimal' },
    // Ollama ignores thinking.type but honours reasoning_effort=none (probe 2026-11-23, qwen3:8b, Ollama 0.40.16).
    none: { reasoning_effort: 'none' },
}

/**
 * Model-name prefix → mode measured in M0 (2026-11-20, 300-turn baseline each):
 * doubao-seed-2-1 default 19% invalid (timeouts) vs disabled 0.7%;
 * glm-5-3 default 49.3% (truncation) vs low 1.7%; deepseek-v4-1 default 5.3%, kept as is.
 */
const VERIFIED_DEFAULTS: Array<{ prefix: string; mode: ReasoningMode }> = [
    { prefix: 'doubao-seed-2-1', mode: 'disabled' },
    { prefix: 'glm-5-3', mode: 'low' },
    { prefix: 'deepseek-v4-1', mode: 'default' },
    // Ollama tag names only ("qwen3:8b"), 2026-11-23: none 3.3% invalid first attempts over 60 turns, p50 4.7 s;
    // thinking on was valid in a 5-turn check but p50 10.7 s, too slow for conversation.
    { prefix: 'qwen3:', mode: 'none' },
]

export function parseReasoningMode(raw: string | undefined | null): ReasoningMode | null {
    const value = raw?.trim().toLowerCase()
    if (!value) return null
    if (value === 'off') return 'disabled'
    if ((REASONING_MODES as readonly string[]).includes(value)) return value as ReasoningMode
    throw new Error(`Unknown reasoning mode "${raw}" (${REASONING_MODES.join(' | ')} | off)`)
}

/** An explicit mode wins; otherwise the verified default for the model; otherwise 'default'. */
export function resolveReasoningMode(model: string, explicit?: ReasoningMode | null): ReasoningMode {
    if (explicit) return explicit
    const name = model.trim().toLowerCase()
    return VERIFIED_DEFAULTS.find((d) => name.startsWith(d.prefix))?.mode ?? 'default'
}

/** A fresh copy of the request-body fields for a mode. */
export function reasoningBody(mode: ReasoningMode): Record<string, unknown> {
    return structuredClone(REASONING_BODIES[mode])
}
