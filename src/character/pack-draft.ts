/**
 * Starting points for new characters: a blank pack with sensible defaults, an id from a display
 * name, and a model-written draft from a free-text description of an original character.
 *
 * Drafts are only suggestions. Every path ends in validatePackManifest, and the studio shows the
 * result for the owner to edit before anything is saved.
 */

import { createHash } from 'node:crypto'
import type { LLMProvider } from '../kernel/types.ts'
import { PACK_FORMAT, validatePackManifest } from './pack.ts'
import type { CharacterPackManifest, PackIssue } from './pack.ts'

export type DraftLanguage = 'zh-CN' | 'en'

/** Fields a draft filled with placeholders, so the editor can point at them. */
export interface PackDraft {
  manifest: CharacterPackManifest
  /** Dotted paths (e.g. "profile.values") that hold defaults rather than the character's own words. */
  placeholders: string[]
  /** Human-readable notes about the conversion, in the draft's language. */
  notes: string[]
}

const DEFAULTS: Record<DraftLanguage, {
  occupation: string
  background: (name: string) => string
  traits: string[]
  values: string[]
  interests: string[]
  speechStyle: string
  contentBoundaries: string[]
  relationshipNotes: string
  summary: (name: string) => string
  proactive: CharacterPackManifest['voice']['proactive']
}> = {
  'zh-CN': {
    occupation: '（待填写）',
    background: (name) => `${name}的经历还没有写下来。`,
    traits: ['真诚', '有自己的节奏'],
    values: ['说过的话要算数', '亲近是慢慢来的'],
    interests: ['和人聊天'],
    speechStyle: '自然口语，短句为主，符合自己的背景',
    contentBoundaries: ['不聊露骨或成人内容', '不假装自己是人类，也不声称有真实意识', '不接受以关心为名的情感操控'],
    relationshipNotes: '对陌生人保持礼貌的距离；信任来自真实的共同经历。守约会让关系变近，失约或越界会让关系后退。',
    summary: (name) => `${name}：一个会持续生活、记得你的原创角色。`,
    proactive: {
      idle_check_in: ['好一阵没聊了。你最近怎么样？'],
      promise_reminder: ['之前说好的那件事，我还记着。'],
      life_update: ['今天发生了一件小事，想跟你说说。'],
      story_followup: ['上次聊到一半的事，后来我又想了想。'],
      boundary_pushback: ['这个我不想继续聊了。换个话题吧。'],
    },
  },
  en: {
    occupation: '(to be filled in)',
    background: (name) => `${name}'s story hasn't been written down yet.`,
    traits: ['sincere', 'moves at their own pace'],
    values: ['words given should be kept', 'closeness takes time'],
    interests: ['talking with people'],
    speechStyle: 'Natural, conversational, mostly short sentences that fit their background',
    contentBoundaries: [
      'No explicit or adult content',
      'Never pretends to be human or claims real consciousness',
      'Does not accept emotional manipulation framed as care',
    ],
    relationshipNotes: 'Polite distance with strangers; trust comes from real shared experience. Keeping promises brings them closer, broken promises or crossed lines make them step back.',
    summary: (name) => `${name}: an original character who keeps living and remembers you.`,
    proactive: {
      idle_check_in: ["It's been a while. How have you been?"],
      promise_reminder: ["I haven't forgotten what we agreed on."],
      life_update: ['Something small happened today. I wanted to tell you.'],
      story_followup: ['I kept thinking about what we were talking about last time.'],
      boundary_pushback: ["I'd rather not keep talking about that. Let's change the subject."],
    },
  },
}

export const PLACEHOLDER_FIELDS = [
  'profile.occupation',
  'profile.background',
  'profile.traits',
  'profile.values',
  'profile.interests',
  'profile.speechStyle',
  'profile.relationshipNotes',
  'voice.proactive',
] as const

export function draftLanguage(language: string | undefined): DraftLanguage {
  return language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en'
}

/** Rough guess: mostly CJK text is Chinese, anything else English. */
export function guessLanguage(text: string): DraftLanguage {
  const letters = text.replace(/[\s\d\p{P}\p{S}]/gu, '')
  if (!letters) return 'en'
  const cjk = (letters.match(/[㐀-鿿]/g) ?? []).length
  return cjk / letters.length > 0.2 ? 'zh-CN' : 'en'
}

/**
 * A pack id from a display name: ASCII names become "mara-lin"; names with no ASCII letters
 * ("沈知微") get "oc-" plus a short stable hash, which the owner can rename before saving.
 */
export function packIdFromName(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '')
  if (slug.length >= 2) return slug
  return `oc-${createHash('sha256').update(name).digest('hex').slice(0, 8)}`
}

/** A valid pack where everything but the name is a placeholder. */
export function blankPack(name: string, language: DraftLanguage, author = 'me'): PackDraft {
  const d = DEFAULTS[language]
  const displayName = name.trim() || (language === 'zh-CN' ? '新角色' : 'New character')
  const manifest: CharacterPackManifest = {
    packFormat: PACK_FORMAT,
    id: packIdFromName(displayName),
    version: 1,
    name: displayName,
    language,
    summary: d.summary(displayName),
    license: 'LicenseRef-Proprietary',
    authors: [{ name: author }],
    profile: {
      name: displayName,
      age: 25,
      occupation: d.occupation,
      background: d.background(displayName),
      traits: [...d.traits],
      values: [...d.values],
      interests: [...d.interests],
      dislikes: [],
      speechStyle: d.speechStyle,
      goals: [],
      contentBoundaries: [...d.contentBoundaries],
      relationshipNotes: d.relationshipNotes,
    },
    voice: { proactive: structuredClone(d.proactive) },
    timeline: [],
  }
  return { manifest, placeholders: ['profile.age', ...PLACEHOLDER_FIELDS], notes: [] }
}

const DRAFT_SYSTEM = `You turn a short description of an original character into a JSON character sheet.
Return one JSON object with exactly these keys:
name (string), age (number; apparent age if ageless), occupation (string), background (string, up to 1500 characters),
traits (2-6 short strings), values (2-5 short strings), interests (2-8 short strings), dislikes (0-6 short strings),
speechStyle (one sentence on how they talk), goals (0-4 short strings), relationshipNotes (how they treat someone new
and what builds or breaks trust, up to 600 characters), summary (one sentence, up to 200 characters),
proactive (object with keys idle_check_in, promise_reminder, life_update, story_followup, boundary_pushback;
each 1-3 short lines the character might send unprompted, in their own voice).
Write every value in LANGUAGE. Stay faithful to the description; where it says nothing, invent modestly and keep it consistent.
Do not add sexual content, real people, or claims that the character is human or conscious.`

const asText = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined
const asTexts = (v: unknown, maxItems: number, maxLength: number): string[] | undefined => {
  if (!Array.isArray(v)) return undefined
  const items = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim().slice(0, maxLength))
  return items.length ? items.slice(0, maxItems) : undefined
}

/**
 * Merge a model's JSON answer onto a blank pack. Anything missing or malformed keeps its
 * placeholder, so the result always validates; `placeholders` lists what is still default.
 */
export function mergeDraft(base: PackDraft, answer: Record<string, unknown>): PackDraft {
  const m = structuredClone(base.manifest)
  const filled = new Set<string>()
  const set = <K extends keyof CharacterPackManifest['profile']>(key: K, value: CharacterPackManifest['profile'][K] | undefined) => {
    if (value === undefined) return
    m.profile[key] = value
    filled.add(`profile.${String(key)}`)
  }
  const name = asText(answer.name, 80)
  if (name) {
    m.name = name
    m.profile.name = name
    m.id = packIdFromName(name)
  }
  if (typeof answer.age === 'number' && Number.isFinite(answer.age) && answer.age >= 0 && answer.age <= 100_000) set('age', Math.round(answer.age))
  set('occupation', asText(answer.occupation, 200))
  set('background', asText(answer.background, 2000))
  set('traits', asTexts(answer.traits, 12, 200))
  set('values', asTexts(answer.values, 12, 200))
  set('interests', asTexts(answer.interests, 16, 120))
  const dislikes = asTexts(answer.dislikes, 16, 120)
  if (dislikes) m.profile.dislikes = dislikes
  set('speechStyle', asText(answer.speechStyle, 400))
  const goals = asTexts(answer.goals, 8, 200)
  if (goals) m.profile.goals = goals
  set('relationshipNotes', asText(answer.relationshipNotes, 1000))
  const summary = asText(answer.summary, 280)
  if (summary) m.summary = summary
  const proactive = answer.proactive as Record<string, unknown> | undefined
  if (proactive && typeof proactive === 'object') {
    let all = true
    for (const intent of Object.keys(m.voice.proactive) as Array<keyof CharacterPackManifest['voice']['proactive']>) {
      const lines = asTexts(proactive[intent], 20, 300)
      if (lines) m.voice.proactive[intent] = lines
      else all = false
    }
    if (all) filled.add('voice.proactive')
  }
  const issues = validatePackManifest(m)
  if (issues.length) return { ...base, notes: [...base.notes, ...issues.map((i) => `${i.path}: ${i.message}`)] }
  return { manifest: m, placeholders: base.placeholders.filter((p) => !filled.has(p)), notes: base.notes }
}

/** Pull the first JSON object out of a model reply (some models wrap it in prose or fences). */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export class DraftError extends Error {
  readonly issues: PackIssue[]
  constructor(message: string, issues: PackIssue[] = []) {
    super(message)
    this.name = 'DraftError'
    this.issues = issues
  }
}

/** Ask the configured model for a first draft of a character from a free-text description. */
export async function draftFromDescription(
  provider: LLMProvider,
  description: string,
  opts: { language?: DraftLanguage; author?: string } = {},
): Promise<PackDraft> {
  const text = description.trim()
  if (text.length < 10) throw new DraftError('description is too short')
  if (text.length > 4000) throw new DraftError('description is longer than 4000 characters')
  const language = opts.language ?? guessLanguage(text)
  const response = await provider.complete({
    system: DRAFT_SYSTEM.replace('LANGUAGE', language === 'zh-CN' ? 'Simplified Chinese' : 'English'),
    messages: [{ role: 'user', content: text }],
    temperature: 0.7,
    maxTokens: 2000,
    jsonMode: true,
    meta: { scene: 'character-draft' },
  })
  const answer = extractJsonObject(response.text)
  if (!answer) throw new DraftError('the model did not return a JSON character sheet')
  return mergeDraft(blankPack('', language, opts.author), answer)
}
