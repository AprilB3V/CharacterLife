/**
 * LLM-backed thinker: one cheap, fast model call per thinking step, strict JSON out.
 *
 * The prompt is role-agnostic; persona, situation and vocabularies come from the request.
 * Output that is not valid JSON or uses unknown values is normalized, and a thinker failure
 * produces a fallback draft that keeps the old behavior (reply) instead of going mute.
 */
import type { LLMProvider } from '../types.ts'
import type { ThinkRequest, Thinker, ThoughtDraft, ThoughtNote } from './types.ts'

export interface LlmThinkerOptions {
  provider: LLMProvider
  temperature?: number
  maxTokens?: number
}

const clamp01 = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0
const shortText = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined

export function buildThinkerPrompt(request: ThinkRequest): { system: string; user: string } {
  const v = request.vocabulary
  const system = [
    '你在替下面这个角色做一次内部判断，不是对外说话。只输出一个 JSON 对象，不要任何其他文字。',
    `角色：${request.persona}`,
    request.situation ? `当前情境：\n${request.situation}` : '',
    '字段：',
    'heard：原样复述新听到的话（多句用 / 分隔）。',
    'meant：对方真正的意思。语音识别可能有同音错字，结合情境推断；推断不出就照抄 heard。',
    'meantConf：0 到 1，你对 meant 的把握。',
    `turn：${v.turns.join('|')}。对方这轮说完了没有、是不是在问你。`,
    `decision：${v.decisions.join('|')}。${v.silent} 表示这次不开口：没话可说、没有依据、对方还没说完，都选 ${v.silent}。`,
    `emotion：${v.emotions.join('|')}。`,
    'intensity：1|2|3。',
    'innerOS：一句内心独白，可以为空。',
    'reason：一句话说明决定的依据，引用具体的数字、物品或对方刚做的事；没有依据就写"没有依据"。',
    'clarifies：只有当新的话是在回答你之前的确认问题时才给出 {"heard": 当时识别的原话, "meant": 确认后的意思}，否则省略。',
  ].filter(Boolean).join('\n')
  const user = [
    request.recent.length ? `最近对话：\n${request.recent.join('\n')}` : '最近对话：无',
    request.pendingClarification
      ? `你之前问过一句确认：识别原话「${request.pendingClarification.heard}」，你猜是「${request.pendingClarification.meant}」。`
      : '',
    request.previous ? `你刚才的内部判断（接着想，不要从头开始）：${JSON.stringify(stripDraft(request.previous))}` : '',
    '新听到/看到的：',
    ...request.inputs.map((input) => `- [${input.kind === 'speech' ? '对方' : '事件'}] ${input.text}`),
  ].filter(Boolean).join('\n')
  return { system, user }
}

function stripDraft(draft: ThoughtDraft): Record<string, unknown> {
  const { fallback: _fallback, ...rest } = draft
  return rest
}

/** Parse and normalize a thinker reply. Returns null when it is not a JSON object. */
export function parseThought(text: string, request: ThinkRequest): ThoughtDraft | null {
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  let raw: unknown
  try { raw = JSON.parse(body) } catch { return null }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const v = request.vocabulary
  const heardFallback = request.inputs.filter((input) => input.kind === 'speech').map((input) => input.text).join(' / ')
  const pick = (candidate: unknown, allowed: readonly string[], fallback: string) =>
    typeof candidate === 'string' && allowed.includes(candidate) ? candidate : fallback
  const intensity = value.intensity === 1 || value.intensity === 2 || value.intensity === 3 ? value.intensity : undefined
  const notes = Array.isArray(value.notes)
    ? value.notes.flatMap((note): ThoughtNote[] => {
        const item = note as Record<string, unknown> | null
        const content = shortText(item?.content, 200)
        return content ? [{ content, source: shortText(item?.source, 40) ?? 'unknown' }] : []
      }).slice(0, 5)
    : undefined
  const clarifiesRaw = value.clarifies as Record<string, unknown> | undefined
  const clarifies = clarifiesRaw && typeof clarifiesRaw === 'object'
    ? { heard: shortText(clarifiesRaw.heard, 200), meant: shortText(clarifiesRaw.meant, 200) }
    : undefined
  return {
    heard: shortText(value.heard, 500) ?? heardFallback,
    meant: shortText(value.meant, 500) ?? shortText(value.heard, 500) ?? heardFallback,
    meantConf: clamp01(value.meantConf),
    turn: pick(value.turn, v.turns, 'done'),
    decision: pick(value.decision, v.decisions, v.silent),
    emotion: pick(value.emotion, v.emotions, v.fallbackEmotion),
    ...(intensity ? { intensity } : {}),
    ...(shortText(value.innerOS, 200) ? { innerOS: shortText(value.innerOS, 200) } : {}),
    ...(shortText(value.reason, 200) ? { reason: shortText(value.reason, 200) } : {}),
    ...(notes?.length ? { notes } : {}),
    ...(clarifies?.heard && clarifies.meant ? { clarifies: { heard: clarifies.heard, meant: clarifies.meant } } : {}),
    chainDepth: request.chainDepth,
  }
}

export class LlmThinker implements Thinker {
  #provider: LLMProvider
  #temperature: number
  #maxTokens: number

  constructor(opts: LlmThinkerOptions) {
    this.#provider = opts.provider
    this.#temperature = opts.temperature ?? 0.2
    this.#maxTokens = opts.maxTokens ?? 400
  }

  async think(request: ThinkRequest): Promise<ThoughtDraft> {
    const prompt = buildThinkerPrompt(request)
    try {
      const response = await this.#provider.complete({
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
        temperature: this.#temperature,
        maxTokens: this.#maxTokens,
        jsonMode: true,
        meta: { purpose: 'think', chainDepth: request.chainDepth, userText: request.inputs.map((input) => input.text).join('\n') },
      })
      const parsed = parseThought(response.text, request)
      if (parsed) return parsed
    } catch {
      // Fall through to the fallback draft.
    }
    return fallbackDraft(request)
  }
}

/** When thinking fails, behave like the pipeline without a thinking layer: reply. */
export function fallbackDraft(request: ThinkRequest): ThoughtDraft {
  const heard = request.inputs.filter((input) => input.kind === 'speech').map((input) => input.text).join(' / ')
  return {
    heard, meant: heard, meantConf: 1, turn: 'done', decision: request.vocabulary.reply,
    emotion: request.vocabulary.fallbackEmotion, reason: 'thinker unavailable', chainDepth: request.chainDepth, fallback: true,
  }
}
