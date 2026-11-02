import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assembleRuntime, defaultTemplate } from '../src/api/runtime-factory.ts'
import type { LLMProvider, LLMRequest } from '../src/types.ts'

test('relaxed capture stores a single stated preference and recalls it after reopening SQLite', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'cl-relaxed-'))
    let lastRequest: LLMRequest | null = null
    const provider: LLMProvider = {
        name: 'offline-memory-check', model: 'offline',
        async complete(request) {
            lastRequest = request
            const captureEnabled = request.system.includes('一次明确表述即可')
            return { text: JSON.stringify({ reply: '记下了。', proposals: [], memoryWrites:
                captureEnabled && request.meta?.userText === '我平时喜欢喝乌龙茶。'
                    ? [{ kind: 'user', title: '用户的茶偏好', content: '用户说自己平时喜欢喝乌龙茶。', status: 'fact', salience: 0.3, tags: ['偏好'] }]
                    : [] }), provider: 'offline-memory-check', model: 'offline', usage: null, latencyMs: 0 }
        },
    }
    const config = { dbPath: join(tempDir, 'character.sqlite'), worldId: 'memory-check', template: defaultTemplate(),
        provider, conversation: { memoryCapture: 'relaxed' as const, memoryLimit: 8, memoryBudgetChars: 1800 },
        budget: { memoryLimit: 8, memoryBudgetChars: 1800 } }
    let runtime = assembleRuntime(config)
    try {
        const identity = runtime.identityService.resolveOrCreate('sillytavern', 'memory-check-user')
        const firstInstanceId = identity.instance.id
        let instance = runtime.runtimeManager.get(firstInstanceId)
        await runtime.runtimeManager.send(instance, { identityKey: 'sillytavern:memory-check-user', text: '我平时喜欢喝乌龙茶。' })
        runtime.runtimeManager.saveSnapshot(instance)
        assert.ok(instance.workspace.memory.list().some(item => item.content.includes('乌龙茶')))
        runtime.close()
        runtime = assembleRuntime(config)
        assert.equal(runtime.identityService.instanceFor('sillytavern', 'memory-check-user'), firstInstanceId)
        instance = runtime.runtimeManager.get(firstInstanceId)
        await runtime.runtimeManager.send(instance, { identityKey: 'sillytavern:memory-check-user', text: '还记得我的茶偏好吗？' })
        const recalledRequest = lastRequest as LLMRequest | null
        assert.ok(recalledRequest)
        assert.ok(recalledRequest.messages.some(message => message.content.includes('乌龙茶')))
        assert.ok(!recalledRequest.system.includes('用户说自己平时喜欢喝乌龙茶。'))
    } finally {
        runtime.close()
        assert.ok(tempDir.startsWith(join(tmpdir(), 'cl-relaxed-')))
        rmSync(tempDir, { recursive: true, force: true })
    }
})
