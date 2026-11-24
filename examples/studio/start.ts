/**
 * Character studio: create, import and edit characters in the browser.
 *
 *   npm run studio
 *
 * Environment:
 *   CHARACTERLIFE_CHARACTERS_DIR  character folder (default ./characters, the one st:server reads)
 *   CHARACTERLIFE_STUDIO_PORT     loopback port (default 8790)
 *   CHARACTERLIFE_STUDIO_AUTHOR   default author name for new characters
 *   CHARACTERLIFE_MODEL_*         same model settings as the servers; used for "describe your character"
 *                                 drafts. Without a model, the studio still imports cards and edits.
 */

import { join, resolve } from 'node:path'
import { chooseProvider } from '../../src/api/runtime-factory.ts'
import { createStudioServer } from '../../src/studio/server.ts'

const charactersDir = resolve(process.env.CHARACTERLIFE_CHARACTERS_DIR?.trim() || join(process.cwd(), 'characters'))
const port = Number(process.env.CHARACTERLIFE_STUDIO_PORT ?? 8790)
const { provider, note } = chooseProvider()

const studio = createStudioServer({
  charactersDir,
  provider,
  port: Number.isInteger(port) && port > 0 ? port : 8790,
  author: process.env.CHARACTERLIFE_STUDIO_AUTHOR?.trim() || 'me',
})
const { openUrl } = await studio.listen()
console.log('CharacterLife 角色工作室 / Character Studio')
console.log(`  打开 Open : ${openUrl}`)
console.log(`  角色库    : ${charactersDir}`)
console.log(`  起草模型  : ${provider.name === 'mock' ? '未配置（只能导入和手动编辑） / none (import and edit only)' : note}`)
console.log('  保存后重启 npm run st:server 生效 / restart st:server after saving')

process.on('SIGINT', () => {
  void studio.close().finally(() => process.exit(0))
})
