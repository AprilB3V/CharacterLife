/**
 * Load a character template from an external module (CHARACTERLIFE_CHARACTER_MODULE).
 *
 * The module exports plain `profile` and `voice` (optional `version`, `timeline`); the template is
 * built here with this kernel's own defineTemplate, so the content hash always matches the kernel
 * that runs it, even if the module was written against another copy of CharacterLife.
 */

import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { defineTemplate } from '../src/character/template.ts'
import type { CharacterTemplate } from '../src/character/template.ts'
import { loadCharacterPack, packModelId } from '../src/character/pack.ts'
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
    const how = was.templateVersion === template.version
      ? `the character changed but "version" is still ${template.version}`
      : `the character moved from version ${was.templateVersion} to ${template.version}`
    return (
      `${stale.length} conversation(s) in ${dbPath} were created with an earlier ${template.id} and won't restore: ${how}.\n` +
      '  Undo the change to keep talking to the existing character, or start with a new CHARACTERLIFE_DB.\n' +
      '  Moving existing relationships to a new version needs a template migration (docs/CHARACTER_PACK.md).'
    )
  }
  return null
}
