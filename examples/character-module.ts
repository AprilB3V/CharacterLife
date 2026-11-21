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
