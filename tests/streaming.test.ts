import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { DeepSeekProvider } from '../src/conversation/providers/deepseek.ts'
import { assembleRuntime } from '../src/api/runtime-factory.ts'
import { createApiServer } from '../src/api/server.ts'
import type { LLMProvider } from '../src/types.ts'

test('incremental envelope decoding emits only the root reply and handles escaped Unicode', async () => {
    assert.ok(existsSync(new URL('../src/conversation/reply-stream.ts', import.meta.url)), 'Incremental reply decoding is missing')
    const { ReplyStreamDecoder } = await import('../src/conversation/reply-stream.ts')
    let output = ''
    const decoder = new ReplyStreamDecoder(delta => { output += delta })
    const envelope = '{"proposals":[{"reply":"NEVER_DISPLAY"}],"reply":"你好\\n\\"鲸鲸\\" \\uD83D\\uDC33","memoryWrites":[]}'
    for (const character of envelope) decoder.push(character)
    assert.equal(output, '你好\n"鲸鲸" 🐳')
    assert.ok(!output.includes('NEVER_DISPLAY'))
})

test('provider forwards actual model chunks before the completion finishes', async () => {
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    let received!: () => void
    const firstDelta = new Promise<void>(resolve => { received = resolve })
    const encoder = new TextEncoder()
    let sentBody: Record<string, unknown> = {}
    const provider = new DeepSeekProvider({ apiKey: 'test-only', fetchImpl: async (_url, init) => {
        sentBody = JSON.parse(String(init?.body))
        const stream = new ReadableStream({ async start(controller) {
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"你好","reasoning_content":"PRIVATE"}}]}\n\n'))
            await gate
            controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"，世界"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":3}}\n\ndata: [DONE]\n\n'))
            controller.close()
        } })
        return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } })
    } })
    let partial = ''
    let settled = false
    const completion = provider.complete({ system: 'test', messages: [], temperature: 0, maxTokens: 80, jsonMode: false,
        onTextDelta: delta => { partial += delta; received() } }).then(value => { settled = true; return value })
    try {
        await Promise.race([firstDelta, new Promise((_, reject) => setTimeout(() => reject(new Error('No model delta before completion')), 1000))])
        assert.equal(sentBody.stream, true)
        assert.equal(partial, '你好')
        assert.equal(settled, false)
    } finally { finish() }
    const result = await completion
    assert.equal(result.text, '你好，世界')
    assert.equal(result.usage?.promptTokens, 10)
    assert.ok(!partial.includes('PRIVATE'))
})

test('native CL SSE emits reply before completion and commits memory only after the full envelope', { timeout: 7000 }, async () => {
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    const envelope = JSON.stringify({ reply: '第一句，第二句。', proposals: [], memoryWrites: [
        { kind: 'user', title: '测试偏好', content: '用户说喜欢松树。', status: 'fact', salience: 0.3, tags: [] },
    ] })
    const provider: LLMProvider = { name: 'test-stream', model: 'test', async complete(request) {
        request.onTextDelta?.(envelope.slice(0, 13))
        await gate
        request.onTextDelta?.(envelope.slice(13))
        return { text: envelope, provider: 'test-stream', model: 'test', usage: null, latencyMs: 1 }
    } }
    const runtime = assembleRuntime({ dbPath: ':memory:', worldId: 'stream-test', provider })
    const api = createApiServer({ runtime, token: 'test-stream-token', port: 0, logger: () => {} })
    const { url } = await api.listen()
    const abort = new AbortController()
    const deadline = setTimeout(() => abort.abort(), 1500)
    try {
        const response = await fetch(url + '/v1/messages', { method: 'POST', signal: abort.signal,
            headers: { authorization: 'Bearer test-stream-token', 'content-type': 'application/json' },
            body: JSON.stringify({ text: '我喜欢松树。', stream: true }) })
        assert.match(response.headers.get('content-type') ?? '', /event-stream/)
        const reader = response.body!.getReader()
        let prefix = ''
        while (!prefix.includes('"type":"delta"')) {
            const chunk = await reader.read()
            assert.equal(chunk.done, false)
            prefix += new TextDecoder().decode(chunk.value)
        }
        clearTimeout(deadline)
        assert.match(prefix, /第一句/)
        const instanceId = runtime.persistence.listInstances()[0]!.id
        assert.equal(runtime.persistence.listMemories(instanceId).length, 0)
        finish()
        let rest = ''
        while (true) { const chunk = await reader.read(); if (chunk.done) break; rest += new TextDecoder().decode(chunk.value) }
        assert.match(rest, /"type":"end"/)
        assert.equal(runtime.persistence.listMemories(instanceId).length, 1)
    } finally {
        clearTimeout(deadline)
        finish()
        abort.abort()
        await api.close()
        runtime.close()
    }
})

test('truncated streamed envelopes do not expose structured fields or commit partial memories', async () => {
    const brokenEnvelope = '{"reply":"开头","memoryWrites":[{"content":"INTERNAL'
    const provider: LLMProvider = { name: 'broken-stream', model: 'test', async complete(request) {
        request.onTextDelta?.(brokenEnvelope)
        return { text: brokenEnvelope, provider: 'broken-stream', model: 'test', usage: null, latencyMs: 0 }
    } }
    const runtime = assembleRuntime({ dbPath: ':memory:', worldId: 'broken-test', provider })
    try {
        const identity = runtime.identityService.resolveOrCreate('sillytavern', 'broken-test')
        const instance = runtime.runtimeManager.get(identity.instance.id)
        let partial = ''
        const result = await runtime.runtimeManager.send(instance, {
            identityKey: 'sillytavern:broken-test', text: '测试不完整回复', onReplyDelta: text => { partial += text },
        })
        assert.equal(partial, '开头')
        assert.ok(!result.reply.includes('memoryWrites'))
        assert.ok(!result.reply.includes('INTERNAL'))
        assert.equal(runtime.persistence.listMemories(identity.instance.id).length, 0)
    } finally { runtime.close() }
})
