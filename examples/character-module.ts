/**
 * Load a character template from an external module (CHARACTERLIFE_CHARACTER_MODULE).
 *
 * The module exports plain `profile` and `voice` (optional `version`, `timeline`); the template is
 * built here with this kernel's own defineTemplate, so the content hash always matches the kernel
 * that runs it, even if the module was written against another copy of CharacterLife.
 */

import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defineTemplate } from '../src/character/template.ts'
import type { CharacterTemplate } from '../src/character/template.ts'
import { loadCharacterPack, packModelId } from '../src/character/pack.ts'
import { scanCharacterPacks, upgradeInstancesToTemplate } from '../src/character/pack-library.ts'
import type { TemplateUpgrade } from '../src/character/pack-library.ts'
import { defaultTemplate } from '../src/api/runtime-factory.ts'
import type { Clock } from '../src/kernel/util/clock.ts'
import type { CharacterPersistence } from '../src/persistence/store.ts'

export async function loadCharacterModule(path: string | undefined): Promise<CharacterTemplate | undefined> {
  if (!path) return undefined
  const mod = (await import(pathToFileURL(resolve(path)).href)) as Record<string, unknown>
  if (!mod.profile || !mod.voice) {
    throw new Error(`角色模块缺少 profile / voice 导出：${path}`)
  }
  return defineTemplate({
    version: typeof mod.version === 'number' ? mod.version : 1,
    profile: mod.profile as CharacterTemplate['profile'],
    voice: mod.voice as CharacterTemplate['voice'],
    timeline: Array.isArray(mod.timeline) ? (mod.timeline as CharacterTemplate['timeline']) : [],
  })
}

export interface CharacterFromEnv {
  template?: CharacterTemplate
  /** Model id for OpenAI-compatible clients, e.g. "characterlife/shen-zhiwei". */
  modelId?: string
  /** Short description for startup logs. */
  label?: string
}

/**
 * Pick the character from the environment: CHARACTERLIFE_CHARACTER_PACK (a data-only pack, see
 * docs/CHARACTER_PACK.md) or CHARACTERLIFE_CHARACTER_MODULE (a TypeScript module). Neither means
 * the built-in test character.
 */
export async function loadCharacterFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<CharacterFromEnv> {
  const packPath = env.CHARACTERLIFE_CHARACTER_PACK?.trim()
  const modulePath = env.CHARACTERLIFE_CHARACTER_MODULE?.trim()
  if (packPath && modulePath) {
    throw new Error('Set either CHARACTERLIFE_CHARACTER_PACK or CHARACTERLIFE_CHARACTER_MODULE, not both')
  }
  if (packPath) {
    const pack = loadCharacterPack(packPath)
    return {
      template: pack.template,
      modelId: packModelId(pack.manifest),
      label: `${pack.manifest.name} ${pack.manifest.id}@${pack.manifest.version} (${pack.dir})`,
    }
  }
  const template = await loadCharacterModule(modulePath)
  return template ? { template, label: `${template.profile.name} (module ${modulePath})` } : {}
}

/**
 * Startup check: does this database belong to this character? Instances remember the template
 * they were created with and refuse to restore against anything else, which otherwise surfaces
 * only as failed replies. Returns a human-readable problem, or null when everything fits.
 */
export function describeTemplateMismatch(
  persistence: Pick<CharacterPersistence, 'listInstances'>,
  template: CharacterTemplate,
  dbPath: string,
): string | null {
  const instances = persistence.listInstances()
  const others = instances.filter((i) => i.templateId !== template.id)
  if (others.length) {
    const ids = [...new Set(others.map((i) => i.templateId))].join(', ')
    return (
      `The database ${dbPath} belongs to another character (${ids}), not ${template.id}.\n` +
      '  Use a separate CHARACTERLIFE_DB for each character.'
    )
  }
  const stale = instances.filter((i) => i.templateVersion !== template.version || i.templateHash !== template.contentHash)
  if (stale.length) {
    const was = stale[0]!
    const fix = was.templateVersion === template.version
      ? {
          how: `the character changed but "version" is still ${template.version}`,
          next: '  Raise "version" in character.json to move them onto the edited character (the character studio does this for you),\n' +
            '  or undo the change to keep talking to the existing character.',
        }
      : was.templateVersion > template.version
        ? {
            how: `they were made with version ${was.templateVersion}, newer than this version ${template.version}`,
            next: '  Use the newer character.json, or start with a new CHARACTERLIFE_DB.',
          }
        : {
            how: `the character moved from version ${was.templateVersion} to ${template.version}`,
            next: '  Remove CHARACTERLIFE_AUTO_MIGRATE=false to move them onto the new version, or start with a new CHARACTERLIFE_DB.',
          }
    return `${stale.length} conversation(s) in ${dbPath} were created with an earlier ${template.id} and won't restore: ${fix.how}.\n${fix.next}`
  }
  return null
}

export interface CharacterEntry {
  template: CharacterTemplate
  modelId: string
  label: string
  dbPath: string
}

export interface CharacterLibrary {
  /** The first entry is the default character. */
  entries: CharacterEntry[]
  /** Packs in the folder that could not be loaded; shown at startup, the others still run. */
  skipped: string[]
  /** Folder that was scanned, or null for a single character from the environment. */
  dir: string | null
}

const BUILTIN_MODEL = 'characterlife/shen-zhiwei'
/** Pack id of the example character shipped in characters/ (answers when a request names no character). */
export const EXAMPLE_CHARACTER = 'jingjing'

/**
 * Every character this server should run:
 * - CHARACTERLIFE_CHARACTER_PACK / _MODULE: just that one, in CHARACTERLIFE_DB (as before);
 * - otherwise every pack in CHARACTERLIFE_CHARACTERS_DIR (default ./characters), each in its own
 *   database next to CHARACTERLIFE_DB (`<id>.db`). The built-in character keeps CHARACTERLIFE_DB so
 *   existing conversations carry on. The default character is CHARACTERLIFE_DEFAULT_CHARACTER (a pack
 *   id), else the example character Jingjing, else Shen Zhiwei, else the first pack.
 */
export async function loadCharacterLibrary(dbPath: string, env: NodeJS.ProcessEnv = process.env): Promise<CharacterLibrary> {
  if (env.CHARACTERLIFE_CHARACTER_PACK?.trim() || env.CHARACTERLIFE_CHARACTER_MODULE?.trim()) {
    const single = await loadCharacterFromEnv(env)
    const template = single.template ?? defaultTemplate()
    return {
      entries: [{ template, modelId: single.modelId ?? BUILTIN_MODEL, label: single.label ?? template.profile.name, dbPath }],
      skipped: [],
      dir: null,
    }
  }
  const dir = resolve(env.CHARACTERLIFE_CHARACTERS_DIR?.trim() || join(process.cwd(), 'characters'))
  const scan = scanCharacterPacks(dir)
  const builtinId = defaultTemplate().id
  const entries: CharacterEntry[] = scan.packs.map((pack) => ({
    template: pack.template,
    modelId: packModelId(pack.manifest),
    label: `${pack.manifest.name} ${pack.manifest.id}@${pack.manifest.version}`,
    dbPath: pack.template.id === builtinId ? dbPath : join(dirname(dbPath), `${pack.manifest.id}.db`),
  }))
  if (entries.length === 0) {
    const template = defaultTemplate()
    entries.push({ template, modelId: BUILTIN_MODEL, label: template.profile.name, dbPath })
  }
  const wanted = env.CHARACTERLIFE_DEFAULT_CHARACTER?.trim()
  // Default: the one asked for, else the example character, else the built-in test character.
  const byId = (id: string) => entries.findIndex((e) => e.modelId === `characterlife/${id}`)
  const first = wanted
    ? byId(wanted)
    : [byId(EXAMPLE_CHARACTER), entries.findIndex((e) => e.template.id === builtinId)].find((i) => i >= 0) ?? -1
  if (wanted && first < 0) throw new Error(`CHARACTERLIFE_DEFAULT_CHARACTER=${wanted} is not in ${dir}`)
  if (first > 0) entries.unshift(...entries.splice(first, 1))
  return { entries, skipped: scan.errors.map((e) => `${e.dir}: ${e.message}`), dir }
}

/**
 * Startup step for every entry point: move conversations from older versions of this character onto
 * the current one (unless CHARACTERLIFE_AUTO_MIGRATE=false), then check the database fits.
 * Returns the migrations done and the remaining problem, if any.
 */
export function prepareCharacterDatabase(
  runtime: { persistence: CharacterPersistence; template: CharacterTemplate; clock: Clock },
  dbPath: string,
  env: NodeJS.ProcessEnv = process.env,
): { upgrades: TemplateUpgrade[]; problem: string | null } {
  const upgrades = env.CHARACTERLIFE_AUTO_MIGRATE === 'false'
    ? []
    : upgradeInstancesToTemplate(runtime.persistence, runtime.template, runtime.clock)
  return { upgrades, problem: describeTemplateMismatch(runtime.persistence, runtime.template, dbPath) }
}
