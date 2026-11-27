/**
 * Try the owner console in one command: in-memory database, the original character, a few
 * seeded turns. Without a model key the character answers with MockProvider; connect a real
 * model on the "模型接入" page (saved to data/console-demo/model-settings.json).
 *
 *   node examples/console-demo.ts            → http://127.0.0.1:8789, token printed below
 *
 *   CHARACTERLIFE_CONSOLE_PORT      default 8789
 *   CHARACTERLIFE_CONSOLE_TOKEN     default a fixed demo token (loopback only)
 *   CHARACTERLIFE_MODEL_SETTINGS    default data/console-demo/model-settings.json
 */

import { resolve } from 'node:path'
import { assembleRuntime } from '../src/api/runtime-factory.ts'
import { createConsoleServer } from '../src/console/server.ts'

const ROOT = resolve(import.meta.dirname, '..')
const TOKEN = process.env.CHARACTERLIFE_CONSOLE_TOKEN?.trim() || 'demo-console-token-local-only'
const PORT = Number(process.env.CHARACTERLIFE_CONSOLE_PORT ?? 8789)
const SETTINGS = process.env.CHARACTERLIFE_MODEL_SETTINGS?.trim() || resolve(ROOT, 'data/console-demo/model-settings.json')

const runtime = assembleRuntime({ dbPath: ':memory:', worldId: 'world_console_demo', auditFile: null, modelSettingsPath: SETTINGS, memoryReview: 'model' })
const identity = runtime.identityService.resolveOrCreate('sillytavern', 'demo-user', '演示用户')
const instance = runtime.runtimeManager.get(identity.instance.id)
for (const text of ['你好，第一次见面', '我有本旧书，被水泡过', '下周我带它来给你看看']) {
    try { await runtime.runtimeManager.send(instance, { identityKey: 'sillytavern:demo-user', text }) }
    catch (error) { console.error(`⚠ 演示对话失败：${(error as Error).message}`) }
}

const handle = createConsoleServer({ runtime, token: TOKEN, port: PORT })
const { url } = await handle.listen()
console.log(`CharacterLife 后台演示：${url}`)
console.log(`令牌：${TOKEN}`)
console.log(`当前模型：${runtime.describe().provider.note}`)
