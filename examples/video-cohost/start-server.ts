import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { assembleRuntime, loadEnvConfig } from '../../src/api/runtime-factory.ts'
import { createApiServer } from '../../src/api/server.ts'
import { createConsoleServer } from '../../src/console/server.ts'
import { verifyTemplate } from '../../src/character/template.ts'
import { jingjingTemplate } from '../characters/jingjing.ts'
import { JingjingKnowledge } from './knowledge.ts'
import { JingjingGameAdapter } from './game-adapter.ts'
import { migrateJingjingTemplate } from './migrate-template.ts'
import { CharacterDatabase } from '../../src/persistence/database.ts'
import { CharacterPersistence } from '../../src/persistence/store.ts'
import { SystemClock } from '../../src/kernel/util/clock.ts'
import { backup } from 'node:sqlite'

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
// Keep world credentials separate from chat credentials and outside browser responses.
const worldTokenPath = resolve(import.meta.dirname, '../../../jingjing-overlay/data/game-world-token.txt')
mkdirSync(dirname(worldTokenPath), { recursive: true })
try { writeFileSync(worldTokenPath, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
}
const worldToken = process.env.JINGJING_WORLD_TOKEN ?? readFileSync(worldTokenPath, 'utf8').trim()
// The owner console has its own token, never shared with chat or world clients.
const consoleTokenPath = resolve(import.meta.dirname, '../../../jingjing-overlay/data/console-token.txt')
try { writeFileSync(consoleTokenPath, randomBytes(24).toString('hex'), { flag: 'wx', mode: 0o600 }) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
}
const consoleToken = process.env.CHARACTERLIFE_CONSOLE_TOKEN ?? readFileSync(consoleTokenPath, 'utf8').trim()
const knowledgePath = resolve(process.env.JINGJING_KNOWLEDGE_PATH
    ?? resolve(import.meta.dirname, '../../../jingjing-overlay/knowledge/Probably-Stolen-鲸鲸知识库-v2.md'))
const knowledge = new JingjingKnowledge(knowledgePath)
// Closing review files live next to the overlay data, outside the repository.
const seasonDir = resolve(process.env.JINGJING_SEASON_DIR ?? resolve(import.meta.dirname, '../../../jingjing-overlay/data/season'))
const migrationDatabase = new CharacterDatabase(dbPath)
try {
    const persistence = new CharacterPersistence(migrationDatabase)
    if (persistence.listInstances({ worldId: 'world_jingjing_video' }).some(instance => instance.templateId === 'maibot')) {
        await backup(migrationDatabase.db, `${dbPath}.before-jingjing-v3-${Date.now()}.sqlite`)
        console.log(`Jingjing templates migrated with backup: ${migrateJingjingTemplate(persistence, new SystemClock())}`)
    }
} finally { migrationDatabase.close() }
const runtime = assembleRuntime({
    configureInstance: (instance, context) => new JingjingGameAdapter({ instance, ...context, knowledge, seasonDir, worldReview: 'review' }),
    memoryReview: 'model',
    dbPath, worldId: 'world_jingjing_video', template: jingjingTemplate, auditFile: null,
    conversation: { memoryCapture: 'relaxed', memoryLimit: 8, memoryBudgetChars: 1800, maxTokens: 1200 },
    budget: { memoryLimit: 8, memoryBudgetChars: 1800 },
    world: { enabled: true, worldIds: ['world_jingjing_video'], acceptObservations: true,
        allowedVerbs: [], allowedTargets: [] },
})
const api = createApiServer({ runtime, token: env.token, host: '127.0.0.1', port: env.port, stIdentityUserId: 'jingjing-video', modelId: 'characterlife/jingjing-video', world: { token: worldToken } })
const { url } = await api.listen()
const ownerConsole = createConsoleServer({ runtime, token: consoleToken, port: Number(process.env.CHARACTERLIFE_CONSOLE_PORT ?? 8788) })
const consoleAddress = await ownerConsole.listen()
console.log(`Video cohost API: ${url}/v1; model: characterlife/jingjing-video`)
console.log('Probably Stolen knowledge loaded: static world context + semantic observations + Memory story gate; world actions disabled.')
console.log(`Season 1 script active; closing reviews in ${seasonDir}`)
console.log(`Owner console: ${consoleAddress.url}/ (token in ${process.env.CHARACTERLIFE_CONSOLE_TOKEN ? 'CHARACTERLIFE_CONSOLE_TOKEN' : consoleTokenPath})`)
console.log('Review: chat-model memories and key world-event effects wait for approval in the console.')
console.log('Database must be exclusive to the video instance. Do not bind it to other platforms.')
process.on('SIGINT', () => { void Promise.all([api.close(), ownerConsole.close()]).finally(() => { runtime.close(); process.exit(0) }) })
