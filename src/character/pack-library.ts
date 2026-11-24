/**
 * A folder of character packs (`characters/<id>/character.json`): listing, saving and moving
 * existing conversations onto an edited character.
 *
 * Editing rule (DECISIONS §22): saving a pack whose character changed bumps `version`; at startup,
 * instances created with an older version of the same character are migrated with the owner's
 * authority, keeping memories and relationships. Same version with different content is still
 * refused, so a hand edit that forgot the bump never silently rewrites a character.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { Clock } from '../kernel/util/clock.ts'
import { OWNER_ACTOR } from '../kernel/policy/policy.ts'
import type { CharacterPersistence } from '../persistence/store.ts'
import type { CharacterTemplate } from './template.ts'
import {
  CharacterPackError,
  MAX_ASSET_BYTES,
  PACK_MANIFEST,
  loadCharacterPack,
  templateFromManifest,
  validatePackManifest,
} from './pack.ts'
import type { CharacterPackManifest, LoadedCharacterPack } from './pack.ts'

export interface PackScan {
  packs: LoadedCharacterPack[]
  /** Packs that failed to load; the rest still work. */
  errors: Array<{ dir: string; message: string }>
}

/** Load every `<root>/<dir>/character.json`, sorted by directory name. A missing root is an empty library. */
export function scanCharacterPacks(root: string): PackScan {
  const scan: PackScan = { packs: [], errors: [] }
  const base = resolve(root)
  if (!existsSync(base)) return scan
  const seen = new Map<string, string>()
  for (const name of readdirSync(base).sort()) {
    const dir = join(base, name)
    if (!statSync(dir).isDirectory() || !existsSync(join(dir, PACK_MANIFEST))) continue
    try {
      const pack = loadCharacterPack(dir)
      const other = seen.get(pack.manifest.id)
      if (other) {
        scan.errors.push({ dir, message: `id "${pack.manifest.id}" is already used by ${other}` })
        continue
      }
      seen.set(pack.manifest.id, dir)
      scan.packs.push(pack)
    } catch (error) {
      scan.errors.push({ dir, message: (error as Error).message })
    }
  }
  return scan
}

export interface SavePackResult {
  dir: string
  manifest: CharacterPackManifest
  created: boolean
  /** True when the character itself changed and the version was bumped. */
  bumped: boolean
}

/**
 * Validate and write `<root>/<manifest.id>/character.json`. The caller's `version` is ignored:
 * a new pack starts at 1, and an existing one keeps its version unless the character (profile,
 * voice or timeline) changed, which bumps it by one. Metadata edits such as the summary never bump.
 */
export function saveCharacterPack(
  root: string,
  input: CharacterPackManifest,
  files: Record<string, Uint8Array> = {},
): SavePackResult {
  const draft = { ...structuredClone(input), version: 1 } as CharacterPackManifest
  const issues = validatePackManifest(draft)
  if (issues.length) throw new CharacterPackError(issues, input.id ?? '(new pack)')
  const dir = join(resolve(root), draft.id)
  let created = true
  let bumped = false
  if (existsSync(join(dir, PACK_MANIFEST))) {
    created = false
    const current = loadCharacterPack(dir)
    const same = templateFromManifest({ ...draft, version: current.manifest.version }).contentHash === current.template.contentHash
    draft.version = same ? current.manifest.version : current.manifest.version + 1
    bumped = !same
  }
  const targets = Object.entries(files).map(([rel, bytes]) => {
    const full = resolve(dir, rel)
    if (rel.includes('\\') || !full.startsWith(dir + sep) || rel === PACK_MANIFEST) {
      throw new CharacterPackError([{ path: rel, message: 'must be a relative path inside the pack' }], draft.id)
    }
    if (bytes.byteLength > MAX_ASSET_BYTES) {
      throw new CharacterPackError([{ path: rel, message: `is larger than ${MAX_ASSET_BYTES} bytes` }], draft.id)
    }
    return { full, bytes }
  })
  mkdirSync(dir, { recursive: true })
  const file = join(dir, PACK_MANIFEST)
  const previous = created ? null : readFileSync(file)
  for (const t of targets) {
    mkdirSync(dirname(t.full), { recursive: true })
    writeFileSync(t.full, t.bytes)
  }
  const tmp = `${file}.tmp`
  const { $schema: _schema, ...rest } = draft as CharacterPackManifest & { $schema?: string }
  writeFileSync(tmp, `${JSON.stringify({ $schema: '../../docs/schemas/character-pack.v1.schema.json', ...rest }, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  try {
    // Declared assets and knowledge files must exist now; undo the save if they don't.
    loadCharacterPack(dir)
  } catch (error) {
    if (previous) writeFileSync(file, previous)
    else rmSync(dir, { recursive: true, force: true })
    throw error
  }
  return { dir, manifest: draft, created, bumped }
}

export interface TemplateUpgrade {
  instanceId: string
  from: number
  to: number
}

/**
 * Move instances of this character created with an older version onto `template`, with the owner's
 * authority (the owner edited the pack). Each move is a recorded `template_migrated` event and an
 * identity revision; memories, relationships and history stay. Other mismatches are left alone for
 * the startup check to report.
 */
export function upgradeInstancesToTemplate(
  persistence: CharacterPersistence,
  template: CharacterTemplate,
  clock: Clock,
): TemplateUpgrade[] {
  const upgrades: TemplateUpgrade[] = []
  for (const instance of persistence.listInstances()) {
    if (instance.templateId !== template.id || instance.templateVersion >= template.version) continue
    const result = persistence.migrateTemplate({
      instanceId: instance.id,
      template,
      actor: OWNER_ACTOR,
      nowSim: clock.nowSim(),
      nowIso: clock.nowWall().toISOString(),
    })
    upgrades.push({ instanceId: instance.id, from: result.from.version, to: result.to.version })
  }
  return upgrades
}
