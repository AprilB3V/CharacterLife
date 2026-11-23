import test from 'node:test'
import assert from 'node:assert/strict'
import {
    DeepSeekProvider,
    ProviderError,
    deepSeekConfigFromEnv,
    hasDeepSeekCredentials,
    isLocalBaseUrl,
} from '../src/conversation/providers/deepseek.ts'

test('local hosts are recognised; remote and malformed URLs are not', () => {
    assert.equal(isLocalBaseUrl('http://localhost:11434/v1'), true)
    assert.equal(isLocalBaseUrl('http://127.0.0.1:1234/v1'), true)
    assert.equal(isLocalBaseUrl('http://[::1]:11434/v1'), true)
    assert.equal(isLocalBaseUrl('http://ollama.localhost/v1'), true)
    assert.equal(isLocalBaseUrl('https://api.deepseek.com'), false)
    assert.equal(isLocalBaseUrl('http://localhost.evil.com/v1'), false)
    assert.equal(isLocalBaseUrl('not a url'), false)
    assert.equal(isLocalBaseUrl(undefined), false)
})

test('a local endpoint needs no API key and sends no Authorization header', async () => {
    let headers: Record<string, string> = {}
    const fetchImpl = (async (_url: string, init: RequestInit) => {
        headers = init.headers as Record<string, string>
        return new Response(JSON.stringify({
            model: 'qwen',
            choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
        }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    const provider = new DeepSeekProvider({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen', fetchImpl })
    const reply = await provider.complete({ system: 's', messages: [{ role: 'user', content: 'hello' }], temperature: 0, maxTokens: 16, jsonMode: false })
    assert.equal(reply.text, 'hi')
    assert.equal('Authorization' in headers, false)
})

test('a remote endpoint without an API key is rejected', () => {
    assert.throws(() => new DeepSeekProvider({ baseUrl: 'https://api.openai.com/v1' }), ProviderError)
    assert.throws(() => new DeepSeekProvider({ apiKey: '   ' }), ProviderError)
})

test('CHARACTERLIFE_MODEL_* wins over DEEPSEEK_*; empty values fall back', () => {
    const cfg = deepSeekConfigFromEnv({
        CHARACTERLIFE_MODEL_API_KEY: 'new-key',
        CHARACTERLIFE_MODEL_BASE_URL: ' ',
        CHARACTERLIFE_MODEL_MODEL: 'gpt-x',
        DEEPSEEK_API_KEY: 'old-key',
        DEEPSEEK_BASE_URL: 'https://api.example.com/v1',
    })!
    assert.equal(cfg.apiKey, 'new-key')
    assert.equal(cfg.baseUrl, 'https://api.example.com/v1')
    assert.equal(cfg.model, 'gpt-x')
    assert.equal(deepSeekConfigFromEnv({ DEEPSEEK_API_KEY: 'old-key' })!.baseUrl, 'https://api.deepseek.com')
})

test('a local base URL alone counts as a configured model; nothing configured stays on Mock', () => {
    const env = { CHARACTERLIFE_MODEL_BASE_URL: 'http://localhost:11434/v1', CHARACTERLIFE_MODEL_MODEL: 'qwen' }
    assert.equal(hasDeepSeekCredentials(env), true)
    assert.equal(deepSeekConfigFromEnv(env)!.apiKey, '')
    assert.equal(hasDeepSeekCredentials({ CHARACTERLIFE_MODEL_BASE_URL: 'https://api.openai.com/v1' }), false)
    assert.equal(deepSeekConfigFromEnv({}), null)
})

test('the thinking model may also run on a keyless local server', async () => {
    const { thinkProviderFromEnv } = await import('../src/api/runtime-factory.ts')
    const local = { CHARACTERLIFE_THINK_BASE_URL: 'http://127.0.0.1:11434/v1', CHARACTERLIFE_THINK_MODEL: 'qwen' }
    assert.ok(thinkProviderFromEnv(local))
    assert.equal(thinkProviderFromEnv({ ...local, CHARACTERLIFE_THINK_BASE_URL: 'https://api.example.com/v1' }), null)
})

test('reasoning mode none maps to reasoning_effort=none, which Ollama honours', async () => {
    const { reasoningBody, parseReasoningMode } = await import('../src/conversation/providers/reasoning.ts')
    assert.deepEqual(reasoningBody(parseReasoningMode('none')!), { reasoning_effort: 'none' })
})

test("Ollama's reasoning field is counted like DeepSeek's reasoning_content", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({
        model: 'qwen3:8b',
        choices: [{ message: { content: '{"reply":"ok"}', reasoning: 'thinking...' }, finish_reason: 'stop' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch
    const provider = new DeepSeekProvider({ baseUrl: 'http://localhost:11434/v1', model: 'qwen3:8b', fetchImpl })
    const reply = await provider.complete({ system: 's', messages: [{ role: 'user', content: 'hi' }], temperature: 0, maxTokens: 16, jsonMode: true })
    assert.equal(reply.reasoningChars, 'thinking...'.length)
    assert.equal(reply.reasoningText, 'thinking...')
})

test('Ollama qwen3 tags default to reasoning none; other qwen3 names are left alone', async () => {
    const { resolveReasoningMode } = await import('../src/conversation/providers/reasoning.ts')
    assert.equal(resolveReasoningMode('qwen3:8b'), 'none')
    assert.equal(resolveReasoningMode('qwen3-32b'), 'default')
})
