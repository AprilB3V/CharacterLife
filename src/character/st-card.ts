/**
 * Import SillyTavern / Character Card V1, V2 and V3 files (PNG with an embedded card, or JSON) as a
 * character pack draft.
 *
 * A card is a prompt; a pack is a character sheet. The conversion is deliberately conservative:
 * the description becomes the background, the personality line becomes traits, the scenario becomes
 * relationship notes, tags become interests. Greetings, example dialogue, the card's own prompts and
 * its lorebook have no pack field yet and are kept verbatim in `knowledge/card.md`. Everything the
 * card does not say stays a placeholder for the owner to fill in.
 */

import { inflateSync } from 'node:zlib'
import { blankPack, guessLanguage, packIdFromName } from './pack-draft.ts'
import type { DraftLanguage, PackDraft } from './pack-draft.ts'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
export const MAX_CARD_BYTES = 8 * 1024 * 1024

export class CardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CardError'
  }
}

/** The card fields this importer reads, whatever the card version. */
export interface CharacterCard {
  spec: 'v1' | 'v2' | 'v3'
  name: string
  description: string
  personality: string
  scenario: string
  firstMessage: string
  exampleMessages: string
  creatorNotes: string
  systemPrompt: string
  postHistoryInstructions: string
  alternateGreetings: string[]
  tags: string[]
  creator: string
  lorebook: Array<{ keys: string[]; content: string }>
}

/** Text chunks of a PNG (tEXt, zTXt, uncompressed or compressed iTXt), by keyword. */
export function pngTextChunks(bytes: Uint8Array): Map<string, string> {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) throw new CardError('not a PNG file')
  const out = new Map<string, string>()
  let at = 8
  while (at + 8 <= buf.length) {
    const length = buf.readUInt32BE(at)
    const type = buf.toString('latin1', at + 4, at + 8)
    const start = at + 8
    const end = start + length
    if (end + 4 > buf.length) throw new CardError('the PNG file is truncated')
    const data = buf.subarray(start, end)
    const nul = data.indexOf(0)
    if (nul > 0 && (type === 'tEXt' || type === 'zTXt' || type === 'iTXt')) {
      const keyword = data.toString('latin1', 0, nul)
      try {
        if (type === 'tEXt') out.set(keyword, data.toString('latin1', nul + 1))
        else if (type === 'zTXt') out.set(keyword, inflateSync(data.subarray(nul + 2)).toString('latin1'))
        else {
          const compressed = data[nul + 1] === 1
          let p = nul + 3
          p = data.indexOf(0, p) + 1 // language tag
          p = data.indexOf(0, p) + 1 // translated keyword
          const body = data.subarray(p)
          out.set(keyword, (compressed ? inflateSync(body) : body).toString('utf8'))
        }
      } catch {
        // A damaged text chunk is skipped; the card chunk may still be elsewhere.
      }
    }
    if (type === 'IEND') break
    at = end + 4
  }
  return out
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** Normalise a parsed V1, V2 or V3 card object. */
export function normalizeCard(raw: unknown): CharacterCard {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new CardError('the card is not a JSON object')
  const top = raw as Record<string, unknown>
  const specName = str(top.spec)
  const isWrapped = (specName === 'chara_card_v2' || specName === 'chara_card_v3') && top.data && typeof top.data === 'object'
  const d = (isWrapped ? top.data : top) as Record<string, unknown>
  const name = str(d.name).trim()
  if (!name) throw new CardError('the card has no name')
  const book = (d.character_book as { entries?: unknown } | undefined)?.entries
  const lorebook = (Array.isArray(book) ? book : [])
    .map((e) => e as Record<string, unknown>)
    .filter((e) => e.enabled !== false && str(e.content).trim())
    .map((e) => ({ keys: strs(e.keys), content: str(e.content).trim() }))
  return {
    spec: specName === 'chara_card_v3' ? 'v3' : isWrapped ? 'v2' : 'v1',
    name,
    description: str(d.description),
    personality: str(d.personality),
    scenario: str(d.scenario),
    firstMessage: str(d.first_mes),
    exampleMessages: str(d.mes_example),
    creatorNotes: str(d.creator_notes ?? d.creatorcomment),
    systemPrompt: str(d.system_prompt),
    postHistoryInstructions: str(d.post_history_instructions),
    alternateGreetings: strs(d.alternate_greetings),
    tags: strs(d.tags),
    creator: str(d.creator),
    lorebook,
  }
}

/** Read a card from PNG or JSON bytes. */
export function readCharacterCard(bytes: Uint8Array): { card: CharacterCard; png: boolean } {
  if (bytes.byteLength > MAX_CARD_BYTES) throw new CardError(`the card is larger than ${MAX_CARD_BYTES} bytes`)
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    const chunks = pngTextChunks(buf)
    const encoded = chunks.get('ccv3') ?? chunks.get('chara')
    if (!encoded) throw new CardError('this PNG has no character card inside (no "chara" or "ccv3" text chunk)')
    let json: unknown
    try {
      json = JSON.parse(Buffer.from(encoded.trim(), 'base64').toString('utf8'))
    } catch {
      throw new CardError('the card inside the PNG is not valid base64 JSON')
    }
    return { card: normalizeCard(json), png: true }
  }
  let json: unknown
  try {
    json = JSON.parse(buf.toString('utf8').replace(/^﻿/, ''))
  } catch {
    throw new CardError('the file is neither a PNG card nor JSON')
  }
  return { card: normalizeCard(json), png: false }
}

const GENERIC_TAGS = new Set(['female', 'male', 'nsfw', 'sfw', 'oc', 'original character', 'character', 'roleplay', 'rp',
  'english', 'chinese', 'anime', 'human', 'non-human', 'girl', 'boy', 'woman', 'man'])

/** Replace {{char}} / {{user}} / <BOT> / <USER> macros, trim, and cut to `max` characters. */
function clean(text: string, name: string, user: string, max: number): { text: string; cut: boolean } {
  const replaced = text
    .replace(/\{\{\s*char\s*\}\}|<BOT>/gi, name)
    .replace(/\{\{\s*user\s*\}\}|<USER>/gi, user)
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return replaced.length > max ? { text: `${replaced.slice(0, max - 1).trimEnd()}…`, cut: true } : { text: replaced, cut: false }
}

function splitList(text: string, maxItems: number, maxLength: number): string[] {
  return text
    .split(/[,，、;；/\n|]+/)
    .map((s) => s.replace(/^[\s\-*•]+|[\s.。]+$/g, '').trim())
    .filter((s) => s.length > 0 && s.length <= maxLength)
    .slice(0, maxItems)
}

function guessAge(text: string): number | null {
  const match = /(\d{1,4})\s*(?:岁|歲|years?[\s-]old|yo\b|-year-old)/i.exec(text) ?? /\bage[d:]?\s*(\d{1,4})\b/i.exec(text)
  const age = match ? Number(match[1]) : NaN
  return Number.isFinite(age) && age > 0 && age < 100_000 ? age : null
}

/** Lines the character says in example dialogue, for a short speech-style hint. */
function exampleLines(examples: string, name: string): string[] {
  return examples
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(\{\{\s*char\s*\}\}|<BOT>)\s*:/i.test(l) || l.startsWith(`${name}:`) || l.startsWith(`${name}：`))
    .map((l) => l.replace(/^[^:：]+[:：]\s*/, '').trim())
    .filter(Boolean)
}

function cardNotes(card: CharacterCard, name: string, user: string): string {
  const parts: string[] = [`# ${name}`, '', `Imported from a Character Card ${card.spec.toUpperCase()}. CharacterLife does not send this file to the model yet; it is kept so nothing from the card is lost.`]
  const section = (title: string, body: string) => {
    const text = clean(body, name, user, 100_000).text
    if (text) parts.push('', `## ${title}`, '', text)
  }
  section('First message', card.firstMessage)
  card.alternateGreetings.forEach((g, i) => section(`Alternate greeting ${i + 1}`, g))
  section('Example dialogue', card.exampleMessages)
  section('Scenario', card.scenario)
  section('Card system prompt', card.systemPrompt)
  section('Post-history instructions', card.postHistoryInstructions)
  section('Creator notes', card.creatorNotes)
  if (card.lorebook.length) {
    parts.push('', '## Lorebook')
    for (const entry of card.lorebook) parts.push('', `### ${entry.keys.join(', ') || '(no keys)'}`, '', clean(entry.content, name, user, 100_000).text)
  }
  return `${parts.join('\n')}\n`
}

export interface CardImport extends PackDraft {
  card: CharacterCard
  /** Files to write into the pack next to character.json. */
  files: Record<string, Uint8Array>
}

/** Turn a card into a pack draft. `png` is the card image, kept as the portrait. */
export function packFromCard(card: CharacterCard, opts: { png?: Uint8Array; language?: DraftLanguage } = {}): CardImport {
  const language = opts.language ?? guessLanguage(`${card.description}\n${card.personality}\n${card.firstMessage}`)
  const zh = language === 'zh-CN'
  const user = zh ? '对方' : 'the user'
  const base = blankPack(card.name, language, card.creator.trim() || (zh ? '未署名' : 'Unknown'))
  const m = base.manifest
  const placeholders = new Set(base.placeholders)
  const notes: string[] = []
  const filled = (path: string) => placeholders.delete(path)

  m.id = packIdFromName(card.name)
  const background = clean(card.description, card.name, user, 2000)
  if (background.text) {
    m.profile.background = background.text
    filled('profile.background')
    if (background.cut) notes.push(zh ? '描述超过 2000 字，背景已截断；全文在 knowledge/card.md。' : 'The description is over 2000 characters and was cut; the full text is in knowledge/card.md.')
  }
  const traits = splitList(clean(card.personality, card.name, user, 4000).text, 12, 200)
  if (traits.length) {
    m.profile.traits = traits
    filled('profile.traits')
  }
  const age = guessAge(`${card.description}\n${card.personality}`)
  if (age !== null) {
    m.profile.age = age
    filled('profile.age')
  }
  const interests = card.tags.map((t) => t.trim()).filter((t) => t && t.length <= 120 && !GENERIC_TAGS.has(t.toLowerCase())).slice(0, 16)
  if (interests.length) {
    m.profile.interests = interests
    filled('profile.interests')
    notes.push(zh ? '兴趣取自卡片标签，请确认。' : 'Interests come from the card tags; check them.')
  }
  const scenario = clean(card.scenario, card.name, user, 1000)
  if (scenario.text) {
    m.profile.relationshipNotes = scenario.text
    filled('profile.relationshipNotes')
  }
  const lines = exampleLines(card.exampleMessages, card.name).map((l) => clean(l, card.name, user, 120).text)
  if (lines.length) {
    const prefix = zh ? '参考说话方式：' : 'Talks like: '
    let style = prefix
    for (const line of lines) {
      const next = `${style}${style === prefix ? '' : ' / '}「${line}」`
      if (next.length > 400) break
      style = next
    }
    if (style !== prefix) {
      m.profile.speechStyle = style
      filled('profile.speechStyle')
    }
  }
  const summary = clean(card.creatorNotes.split(/\n/)[0] ?? '', card.name, user, 280).text
  if (summary) m.summary = summary
  m.license = 'LicenseRef-Unspecified'
  notes.push(zh
    ? '许可证未知：分享这个角色包前，请确认你有权使用这张卡和它的图片。'
    : 'Licence unknown: before sharing this pack, make sure you may use the card and its image.')

  const files: Record<string, Uint8Array> = { 'knowledge/card.md': Buffer.from(cardNotes(card, card.name, user), 'utf8') }
  m.knowledge = ['knowledge/card.md']
  if (opts.png) {
    files['portrait.png'] = opts.png
    m.assets = { portrait: 'portrait.png' }
  }
  notes.push(zh
    ? '开场白、示例对话、卡片提示词和世界书保存在 knowledge/card.md，暂时不会发给模型。'
    : 'Greetings, example dialogue, the card prompts and the lorebook are kept in knowledge/card.md and are not sent to the model yet.')
  return { manifest: m, placeholders: [...placeholders], notes, card, files }
}

/** Read a card file and convert it in one step. */
export function importCharacterCard(bytes: Uint8Array, opts: { language?: DraftLanguage } = {}): CardImport {
  const { card, png } = readCharacterCard(bytes)
  return packFromCard(card, { ...opts, ...(png ? { png: bytes } : {}) })
}
