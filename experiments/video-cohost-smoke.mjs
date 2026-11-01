import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assembleRuntime } from '../src/api/runtime-factory.ts'
import { createApiServer } from '../src/api/server.ts'
import { jingjingTemplate } from '../examples/characters/jingjing.ts'
import { MockProvider } from '../src/conversation/providers/mock.ts'

const folder = mkdtempSync(join(tmpdir(), 'cl-video-smoke-'))
const dbPath = join(folder, 'video.db')
const token = 'temporary-smoke-token'
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
async function start() {
    const runtime = assembleRuntime({ dbPath, worldId: 'video', template: jingjingTemplate, provider: new MockProvider() })
    const api = createApiServer({ runtime, token, port: 0, modelId: 'characterlife/jingjing-video', stIdentityUserId: 'video-smoke', logger: () => {} })
    const { url } = await api.listen()
    return { runtime, api, url }
}
async function request(url, path, body) {
    const response = await fetch(`${url}${path}`, { headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) })
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
    return response
}
let running
try {
    running = await start()
    const models = await (await request(running.url, '/v1/models')).json()
    if (models.data[0].id !== 'characterlife/jingjing-video') throw new Error('Model mismatch')
    const messages = [{ role: 'system', content: 'SENTINEL_SYSTEM_DO_NOT_STORE' }, { role: 'user', content: '旧历史不会重新写入，旧历史测试标记。' }, { role: 'assistant', content: '旧回复' }, { role: 'user', content: '今天测试用的紫色小鲸鱼在游戏里捡到了一把雨伞。' }]
    const completion = await (await request(running.url, '/v1/chat/completions', { model: models.data[0].id, messages })).json()
    if (!completion.choices[0].message.content) throw new Error('Empty completion')
    const identity = await (await request(running.url, '/v1/identity/me')).json()
    const before = await (await request(running.url, `/v1/characters/${identity.instanceId}/memories`)).json()
    const stream = await (await request(running.url, '/v1/chat/completions', { model: models.data[0].id, messages: [...messages, { role: 'assistant', content: completion.choices[0].message.content }, { role: 'user', content: '这次继续测试流式接口。' }], stream: true })).text()
    if (!stream.includes('data: [DONE]')) throw new Error('Missing SSE terminator')
    await running.api.close(); running.runtime.close(); running = null
    running = await start()
    const restored = await (await request(running.url, '/v1/identity/me')).json()
    const after = await (await request(running.url, `/v1/characters/${restored.instanceId}/memories`)).json()
    if (identity.instanceId !== restored.instanceId || !before.memories.length || after.memories.length < before.memories.length) throw new Error('Persistence check failed')
    console.log(JSON.stringify({ models: 'ok', completion: 'ok', sse: 'ok', sameInstanceAfterRestart: true, memoriesBeforeRestart: before.memories.length, memoriesAfterRestart: after.memories.length }))
} finally {
    if (running) { await running.api.close(); running.runtime.close() }
    rmSync(folder, { recursive: true, force: true })
}
