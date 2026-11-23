/**
 * Character packs: a shareable, data-only way to define a character.
 *
 * A pack is a directory with a `character.json` manifest (format in docs/CHARACTER_PACK.md and
 * docs/schemas/character-pack.v1.schema.json) plus optional assets and knowledge files. Unlike a
 * character module (CHARACTERLIFE_CHARACTER_MODULE), a pack never runs code, so a pack from a
 * stranger can be validated and loaded safely.
 *
 * The pack becomes a CharacterTemplate through defineTemplate, so the usual guarantees hold:
 * the template is frozen, hashed, and an instance refuses to restore against a changed pack
 * unless the pack's version was bumped and the instance migrated.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, normalize, resolve, sep } from 'node:path'
import type { CharacterProfile, CharacterVoice, EventKind, ProactiveIntent } from '../types.ts'
import { defineTemplate } from './template.ts'
import type { CharacterTemplate, TemplateEventSpec } from './template.ts'

export const PACK_FORMAT = 1
export const PACK_MANIFEST = 'character.json'
export const MAX_MANIFEST_BYTES = 256 * 1024
export const MAX_ASSET_BYTES = 8 * 1024 * 1024

const PROACTIVE_INTENTS: ProactiveIntent[] = [
  'idle_check_in',
  'promise_reminder',
  'life_update',
  'story_followup',
  'boundary_pushback',
]
const EVENT_KINDS: EventKind[] = ['plot', 'life', 'reminder', 'consequence']
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const EVENT_ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/
const IMAGE_EXT = /\.(png|webp|jpe?g)$/i
const KNOWLEDGE_EXT = /\.(md|txt|json)$/i
const DURATION = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?$/
const MINUTE = 60_000

export interface PackAuthor {
  name: string
  url?: string
}

export interface PackEvent {
  id: string
  kind: EventKind
  /** Fictional time since the story starts, as "2d", "26h", "1d2h30m" or "0". */
  at: string
  title: string
  description: string
  payload?: Record<string, unknown>
}

export interface CharacterPackManifest {
  packFormat: 1
  id: string
  version: number
  name: string
  language: string
  summary: string
  license: string
  authors: PackAuthor[]
  homepage?: string
  /** Template id override; defaults to `char_<id with - replaced by _>`. Keep it once instances exist. */
  templateId?: string
  profile: Omit<CharacterProfile, 'id' | 'version' | 'immutable'>
  voice: CharacterVoice
  timeline?: PackEvent[]
  assets?: {
    portrait?: string
    expressions?: Record<string, string>
    /** Licence of the art if it differs from `license`, e.g. "CC-BY-NC-4.0". */
    license?: string
  }
  knowledge?: string[]
}

export interface PackIssue {
  path: string
  message: string
}

export class CharacterPackError extends Error {
  readonly issues: PackIssue[]
  constructor(issues: PackIssue[], where: string) {
    super(`Invalid character pack ${where}:\n${issues.map((i) => `  ${i.path}: ${i.message}`).join('\n')}`)
    this.name = 'CharacterPackError'
    this.issues = issues
  }
}

export interface LoadedCharacterPack {
  dir: string
  manifest: CharacterPackManifest
  template: CharacterTemplate
  /** Absolute paths of declared files, for apps that show art or read knowledge. */
  files: { portrait?: string; expressions: Record<string, string>; knowledge: string[] }
}

/** `characterlife/<id>`: the model name SillyTavern and other OpenAI clients see. */
export function packModelId(manifest: Pick<CharacterPackManifest, 'id'>): string {
  return `characterlife/${manifest.id}`
}

export function packTemplateId(manifest: Pick<CharacterPackManifest, 'id' | 'templateId'>): string {
  return manifest.templateId ?? `char_${manifest.id.replaceAll('-', '_')}`
}

/** Parse "1d2h30m", "26h", "0" into milliseconds; null when malformed. */
export function parsePackDuration(text: string): number | null {
  if (text === '0') return 0
  const match = DURATION.exec(text)
  if (!match || text === '') return null
  const [, d, h, m] = match
  return ((Number(d ?? 0) * 24 + Number(h ?? 0)) * 60 + Number(m ?? 0)) * MINUTE
}

/** Format milliseconds back into the shortest duration string (used when exporting packs). */
export function formatPackDuration(ms: number): string {
  if (ms === 0) return '0'
  if (ms % MINUTE !== 0 || ms < 0) throw new RangeError(`Timeline times must be whole minutes, got ${ms} ms`)
  let minutes = ms / MINUTE
  const d = Math.floor(minutes / 1440)
  minutes -= d * 1440
  const h = Math.floor(minutes / 60)
  const m = minutes - h * 60
  return `${d ? `${d}d` : ''}${h ? `${h}h` : ''}${m ? `${m}m` : ''}`
}

class Checker {
  readonly issues: PackIssue[] = []

  fail(path: string, message: string): void {
    this.issues.push({ path, message })
  }

  object(value: unknown, path: string): value is Record<string, unknown> {
    if (value && typeof value === 'object' && !Array.isArray(value)) return true
    this.fail(path, 'must be an object')
    return false
  }

  text(value: unknown, path: string, max: number, opts: { optional?: boolean; min?: number } = {}): void {
    if (value === undefined && opts.optional) return
    if (typeof value !== 'string') return this.fail(path, 'must be a string')
    const trimmed = value.trim()
    if (trimmed.length < (opts.min ?? 1)) return this.fail(path, 'must not be empty')
    if (value.length > max) this.fail(path, `is ${value.length} characters; the limit is ${max}`)
  }

  texts(value: unknown, path: string, opts: { min: number; maxItems: number; maxLength: number }): void {
    if (!Array.isArray(value)) return this.fail(path, 'must be an array of strings')
    if (value.length < opts.min) this.fail(path, `needs at least ${opts.min} item(s)`)
    if (value.length > opts.maxItems) this.fail(path, `has ${value.length} items; the limit is ${opts.maxItems}`)
    value.forEach((item, i) => this.text(item, `${path}[${i}]`, opts.maxLength))
  }

  unknownKeys(obj: Record<string, unknown>, allowed: string[], path: string): void {
    for (const key of Object.keys(obj)) {
      if (!allowed.includes(key)) this.fail(path ? `${path}.${key}` : key, 'is not a known field')
    }
  }

  relativeFile(value: unknown, path: string, ext: RegExp): void {
    if (typeof value !== 'string' || value === '') return this.fail(path, 'must be a relative file path')
    const norm = normalize(value)
    if (isAbsolute(value) || /^[A-Za-z]:/.test(value) || norm.startsWith('..') || value.includes('\\')) {
      return this.fail(path, 'must be a relative path inside the pack, using forward slashes')
    }
    if (!ext.test(value)) this.fail(path, `has an unsupported file type (allowed: ${ext.source})`)
  }
}

/**
 * Check a parsed manifest. Returns every problem found rather than stopping at the first, so pack
 * authors can fix them in one go. File existence is checked separately by loadCharacterPack.
 */
export function validatePackManifest(raw: unknown): PackIssue[] {
  const c = new Checker()
  if (!c.object(raw, '(root)')) return c.issues
  const m = raw
  c.unknownKeys(
    m,
    ['$schema', 'packFormat', 'id', 'version', 'name', 'language', 'summary', 'license', 'authors', 'homepage',
      'templateId', 'profile', 'voice', 'timeline', 'assets', 'knowledge'],
    '',
  )
  if (m.packFormat !== PACK_FORMAT) c.fail('packFormat', `must be ${PACK_FORMAT}`)
  if (typeof m.id !== 'string' || !ID_PATTERN.test(m.id) || m.id.length > 48) {
    c.fail('id', 'must be lowercase letters, digits and single hyphens, up to 48 characters (e.g. "shen-zhiwei")')
  }
  if (!Number.isInteger(m.version) || (m.version as number) < 1) c.fail('version', 'must be an integer ≥ 1')
  c.text(m.name, 'name', 80)
  if (typeof m.language !== 'string' || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(m.language)) {
    c.fail('language', 'must be a BCP 47 tag such as "en", "zh-CN" or "ja"')
  }
  c.text(m.summary, 'summary', 280)
  if (typeof m.license !== 'string' || !/^[A-Za-z0-9.+() -]{2,64}$/.test(m.license)) {
    c.fail('license', 'must be an SPDX expression such as "CC-BY-4.0", or "LicenseRef-Proprietary"')
  }
  if (!Array.isArray(m.authors) || m.authors.length === 0) c.fail('authors', 'needs at least one author')
  else {
    m.authors.forEach((a, i) => {
      if (!c.object(a, `authors[${i}]`)) return
      c.unknownKeys(a, ['name', 'url'], `authors[${i}]`)
      c.text(a.name, `authors[${i}].name`, 80)
      c.text(a.url, `authors[${i}].url`, 200, { optional: true })
    })
  }
  c.text(m.homepage, 'homepage', 200, { optional: true })
  if (m.templateId !== undefined && (typeof m.templateId !== 'string' || !/^[A-Za-z0-9_]{1,64}$/.test(m.templateId))) {
    c.fail('templateId', 'must be letters, digits and underscores')
  }

  if (c.object(m.profile, 'profile')) {
    const p = m.profile
    c.unknownKeys(
      p,
      ['name', 'age', 'occupation', 'background', 'traits', 'values', 'interests', 'dislikes', 'speechStyle',
        'goals', 'contentBoundaries', 'relationshipNotes', 'shortPersona'],
      'profile',
    )
    c.text(p.name, 'profile.name', 80)
    if (typeof p.age !== 'number' || !Number.isFinite(p.age) || p.age < 0 || p.age > 100_000) {
      c.fail('profile.age', 'must be a number (use the apparent age for ageless beings)')
    }
    c.text(p.occupation, 'profile.occupation', 200)
    c.text(p.background, 'profile.background', 2000)
    c.texts(p.traits, 'profile.traits', { min: 1, maxItems: 12, maxLength: 200 })
    c.texts(p.values, 'profile.values', { min: 1, maxItems: 12, maxLength: 200 })
    c.texts(p.interests, 'profile.interests', { min: 1, maxItems: 16, maxLength: 120 })
    c.texts(p.dislikes, 'profile.dislikes', { min: 0, maxItems: 16, maxLength: 120 })
    c.text(p.speechStyle, 'profile.speechStyle', 400)
    c.texts(p.goals, 'profile.goals', { min: 0, maxItems: 8, maxLength: 200 })
    c.texts(p.contentBoundaries, 'profile.contentBoundaries', { min: 1, maxItems: 12, maxLength: 200 })
    c.text(p.relationshipNotes, 'profile.relationshipNotes', 1000)
    c.text(p.shortPersona, 'profile.shortPersona', 600, { optional: true })
  }

  if (c.object(m.voice, 'voice')) {
    c.unknownKeys(m.voice, ['proactive'], 'voice')
    if (c.object(m.voice.proactive, 'voice.proactive')) {
      const proactive = m.voice.proactive
      c.unknownKeys(proactive, PROACTIVE_INTENTS, 'voice.proactive')
      for (const intent of PROACTIVE_INTENTS) {
        c.texts(proactive[intent], `voice.proactive.${intent}`, { min: 1, maxItems: 20, maxLength: 300 })
      }
    }
  }

  if (m.timeline !== undefined) {
    if (!Array.isArray(m.timeline)) c.fail('timeline', 'must be an array')
    else {
      if (m.timeline.length > 200) c.fail('timeline', `has ${m.timeline.length} events; the limit is 200`)
      const seen = new Set<string>()
      m.timeline.forEach((e, i) => {
        const path = `timeline[${i}]`
        if (!c.object(e, path)) return
        c.unknownKeys(e, ['id', 'kind', 'at', 'title', 'description', 'payload'], path)
        if (typeof e.id !== 'string' || !EVENT_ID_PATTERN.test(e.id)) c.fail(`${path}.id`, 'must be 1–64 letters, digits, _ . -')
        else if (seen.has(e.id)) c.fail(`${path}.id`, `duplicates "${e.id}"`)
        else seen.add(e.id)
        if (!EVENT_KINDS.includes(e.kind as EventKind)) c.fail(`${path}.kind`, `must be one of ${EVENT_KINDS.join(', ')}`)
        if (typeof e.at !== 'string' || parsePackDuration(e.at) === null) c.fail(`${path}.at`, 'must look like "0", "9h", "2d" or "1d2h30m"')
        c.text(e.title, `${path}.title`, 120)
        c.text(e.description, `${path}.description`, 500)
        if (e.payload !== undefined) c.object(e.payload, `${path}.payload`)
      })
    }
  }

  if (m.assets !== undefined && c.object(m.assets, 'assets')) {
    const a = m.assets
    c.unknownKeys(a, ['portrait', 'expressions', 'license'], 'assets')
    if (a.portrait !== undefined) c.relativeFile(a.portrait, 'assets.portrait', IMAGE_EXT)
    if (a.expressions !== undefined && c.object(a.expressions, 'assets.expressions')) {
      for (const [name, file] of Object.entries(a.expressions)) {
        if (!/^[a-z][a-z0-9_]{0,31}$/.test(name)) c.fail(`assets.expressions.${name}`, 'expression names are lowercase, e.g. "neutral"')
        c.relativeFile(file, `assets.expressions.${name}`, IMAGE_EXT)
      }
    }
    if (a.license !== undefined && (typeof a.license !== 'string' || !/^[A-Za-z0-9.+() -]{2,64}$/.test(a.license))) {
      c.fail('assets.license', 'must be an SPDX expression')
    }
  }

  if (m.knowledge !== undefined) {
    if (!Array.isArray(m.knowledge)) c.fail('knowledge', 'must be an array of file paths')
    else m.knowledge.forEach((f, i) => c.relativeFile(f, `knowledge[${i}]`, KNOWLEDGE_EXT))
  }
  return c.issues
}

/** Build the kernel template from a validated manifest. */
export function templateFromManifest(manifest: CharacterPackManifest): CharacterTemplate {
  const profile: CharacterProfile = {
    ...structuredClone(manifest.profile),
    id: packTemplateId(manifest),
    version: manifest.version,
    immutable: true,
  }
  const timeline: TemplateEventSpec[] = (manifest.timeline ?? []).map((e) => ({
    id: e.id,
    atSim: parsePackDuration(e.at)!,
    kind: e.kind,
    title: e.title,
    description: e.description,
    payload: structuredClone(e.payload ?? {}),
  }))
  return defineTemplate({
    version: manifest.version,
    profile,
    voice: structuredClone(manifest.voice),
    timeline,
  })
}

function insidePack(dir: string, file: string): string {
  const full = resolve(dir, file)
  const root = resolve(dir)
  if (full !== root && !full.startsWith(root + sep)) throw new Error(`path escapes the pack: ${file}`)
  return full
}

/**
 * Read, validate and build a pack. `path` may be the pack directory or its character.json.
 * Throws CharacterPackError listing every problem.
 */
export function loadCharacterPack(path: string): LoadedCharacterPack {
  const manifestPath = path.endsWith('.json') ? resolve(path) : join(resolve(path), PACK_MANIFEST)
  const dir = resolve(manifestPath, '..')
  if (!existsSync(manifestPath)) throw new CharacterPackError([{ path: PACK_MANIFEST, message: 'not found' }], dir)
  const size = statSync(manifestPath).size
  if (size > MAX_MANIFEST_BYTES) {
    throw new CharacterPackError([{ path: PACK_MANIFEST, message: `is ${size} bytes; the limit is ${MAX_MANIFEST_BYTES}` }], dir)
  }
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^﻿/, ''))
  } catch (error) {
    throw new CharacterPackError([{ path: PACK_MANIFEST, message: `is not valid JSON: ${(error as Error).message}` }], dir)
  }
  const issues = validatePackManifest(raw)
  const manifest = raw as CharacterPackManifest
  const files: LoadedCharacterPack['files'] = { expressions: {}, knowledge: [] }
  if (issues.length === 0) {
    const checkFile = (rel: string, where: string): string | undefined => {
      try {
        const full = insidePack(dir, rel)
        if (!existsSync(full) || !statSync(full).isFile()) issues.push({ path: where, message: `file not found: ${rel}` })
        else if (statSync(full).size > MAX_ASSET_BYTES) issues.push({ path: where, message: `is larger than ${MAX_ASSET_BYTES} bytes` })
        else return full
      } catch (error) {
        issues.push({ path: where, message: (error as Error).message })
      }
      return undefined
    }
    if (manifest.assets?.portrait) files.portrait = checkFile(manifest.assets.portrait, 'assets.portrait')
    for (const [name, rel] of Object.entries(manifest.assets?.expressions ?? {})) {
      const full = checkFile(rel, `assets.expressions.${name}`)
      if (full) files.expressions[name] = full
    }
    manifest.knowledge?.forEach((rel, i) => {
      const full = checkFile(rel, `knowledge[${i}]`)
      if (full) files.knowledge.push(full)
    })
  }
  if (issues.length) throw new CharacterPackError(issues, dir)
  return { dir, manifest, template: templateFromManifest(manifest), files }
}
