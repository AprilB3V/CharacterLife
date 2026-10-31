import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { assembleRuntime, loadEnvConfig } from '../../src/api/runtime-factory.ts'
import { createApiServer } from '../../src/api/server.ts'
import { verifyTemplate } from '../../src/character/template.ts'
import { jingjingTemplate } from '../characters/jingjing.ts'

const env = loadEnvConfig()
if (!env.token || env.token.length < 8 || !process.env.CHARACTERLIFE_VIDEO_DB) {
    throw new Error('Set CHARACTERLIFE_API_TOKEN and a separate CHARACTERLIFE_VIDEO_DB before starting.')
}
const dbPath = resolve(process.env.CHARACTERLIFE_VIDEO_DB)
if (process.env.CHARACTERLIFE_DB && resolve(process.env.CHARACTERLIFE_DB) === dbPath) {
    throw new Error('The video database must be separate from CHARACTERLIFE_DB.')
}
verifyTemplate(jingjingTemplate)
mkdirSync(dirname(dbPath), { recursive: true })
const runtime = assembleRuntime({ dbPath, worldId: 'world_jingjing_video', template: jingjingTemplate, auditFile: null })
const api = createApiServer({ runtime, token: env.token, host: '127.0.0.1', port: env.port, stIdentityUserId: 'jingjing-video', modelId: 'characterlife/jingjing-video' })
const { url } = await api.listen()
console.log(`Video cohost API: ${url}/v1; model: characterlife/jingjing-video`)
console.log('Database must be exclusive to the video instance. Do not bind it to other platforms.')
process.on('SIGINT', () => { void api.close().finally(() => { runtime.close(); process.exit(0) }) })
