import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assembleRuntime } from '../src/api/runtime-factory.ts'
import { createConsoleServer } from '../src/console/server.ts'
import {
    normalizeBaseUrl, publicProfile, resolveDraftKey, emptyModelSettings, modelSettingsPathFor,
} from '../src/conversation/providers/model-settings.ts'
import type { ModelSettings } from '../src/conversation/providers/model-settings.ts'

const TOKEN = 'console-token-for-tests-0123'
const SECRET = 'sk-test-secret-value-9876'

/** Fake vendor: records calls, answers /models and /chat/completions. */
function fakeVendor() {
    const calls: Array<{ url: string; auth: string | null; body: Record<string, unknown> | null }> = []
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        const headers = new Headers(init?.headers)
        calls.push({ url, auth: headers.get('authorization'), body: init?.body ? JSON.parse(String(init.body)) : null })
        if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'models/gemini-b' }, { id: 'gemini-a' }] }), { status: 200 })
        return new Response(JSON.stringify({ choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
            { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    return { calls, fetchImpl }
}

async function boot(dir: string, env: NodeJS.ProcessEnv = {}) {
    const vendor = fakeVendor()
    const runtime = assembleRuntime({ dbPath: ':memory:', worldId: 'world_test', auditFile: null, modelSettingsPath: join(dir, 'model-settings.json') })
    const handle = createConsoleServer({ runtime, token: TOKEN, port: 0, model: { env, fetchImpl: vendor.fetchImpl } })
    const { url } = await handle.listen()
    const call = async (path: string, body?: unknown) => {
        const response = await fetch(`${url}/api${path}`, { method: body === undefined ? 'GET' : 'POST',
            headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
        const text = await response.text()
        return { status: response.status, text, json: JSON.parse(text) }
    }
    return { runtime, handle, call, vendor, close: async () => { await handle.close(); runtime.close() } }
}

test('base URLs: HTTPS or loopback HTTP only, and a pasted /chat/completions is trimmed', () => {
    assert.equal(normalizeBaseUrl('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1')
    assert.equal(normalizeBaseUrl('http://127.0.0.1:11434/v1/'), 'http://127.0.0.1:11434/v1')
    assert.throws(() => normalizeBaseUrl('http://api.example.com/v1'), /HTTPS/)
    assert.throws(() => normalizeBaseUrl('https://user:pw@api.example.com'), /账号/)
    assert.throws(() => normalizeBaseUrl('https://api.example.com/v1?key=1'), /查询参数/)
})

test('a stored key is reused only for the same origin, so it never reaches another vendor', () => {
    const settings: ModelSettings = { ...emptyModelSettings(), profiles: [{ id: 'm1', label: 'a', preset: 'deepseek', baseUrl: 'https://api.deepseek.com',
        model: 'deepseek-chat', apiKey: SECRET, updatedAt: '' }] }
    assert.equal(resolveDraftKey({ id: 'm1' }, settings, 'https://api.deepseek.com', {}).key, SECRET)
    assert.throws(() => resolveDraftKey({ id: 'm1', preset: 'custom' }, settings, 'https://evil.example.com/v1', {}), /API Key/)
    // A preset's conventional environment variable is picked up and stored by name, not by value.
    const fromEnv = resolveDraftKey({ preset: 'gemini' }, settings, 'https://generativelanguage.googleapis.com/v1beta/openai', { GEMINI_API_KEY: 'g-key' })
    assert.deepEqual(fromEnv, { key: 'g-key', store: { apiKeyEnv: 'GEMINI_API_KEY' } })
    assert.equal(resolveDraftKey({ preset: 'ollama' }, settings, 'http://127.0.0.1:11434/v1', {}).key, 'local-no-key')
    const pub = publicProfile(settings.profiles[0]!, {})
    assert.equal('apiKey' in pub, false)
    assert.equal(pub.keyHint, '••••9876')
    assert.equal(modelSettingsPathFor(':memory:', {}), null)
})

test('console saves a Gemini connection, swaps the live model, and never echoes the key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cl-model-'))
    const app = await boot(dir)
    try {
        const draft = { preset: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-flash-latest', apiKey: SECRET }
        const tested = await app.call('/model/test', draft)
        assert.equal(tested.status, 200, tested.text)
        assert.equal(tested.json.reply, 'pong')
        assert.equal(app.vendor.calls.at(-1)!.url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions')
        assert.equal(app.vendor.calls.at(-1)!.auth, `Bearer ${SECRET}`)

        const listed = await app.call('/model/models', draft)
        assert.deepEqual(listed.json.models, ['gemini-a', 'gemini-b'])

        const saved = await app.call('/model/profiles', { ...draft, activate: true })
        assert.equal(saved.status, 200, saved.text)
        assert.equal(app.runtime.provider.model, 'gemini-flash-latest')
        assert.equal(app.runtime.provider.name, 'gemini')
        assert.equal(app.runtime.describe().provider.model, 'gemini-flash-latest')

        const info = await app.call('/model')
        assert.ok(!info.text.includes(SECRET), 'the key never leaves the server')
        assert.equal(info.json.active, saved.json.id)
        assert.equal(info.json.profiles[0].keySource, 'stored')
        assert.equal(JSON.parse(readFileSync(join(dir, 'model-settings.json'), 'utf8')).profiles[0].apiKey, SECRET)

        // Editing with an empty key keeps the stored one.
        const edited = await app.call('/model/profiles', { ...draft, id: saved.json.id, apiKey: '', model: 'gemini-a' })
        assert.equal(edited.status, 200, edited.text)
        assert.equal(app.runtime.provider.model, 'gemini-a', 'editing the active connection applies at once')

        // A restart picks the saved connection up.
        const again = assembleRuntime({ dbPath: ':memory:', worldId: 'world_test', auditFile: null, modelSettingsPath: join(dir, 'model-settings.json') })
        try {
            assert.equal(again.provider.model, 'gemini-a')
            assert.match(again.describe().provider.note, /后台配置/)
        } finally { again.close() }

        const removed = await app.call(`/model/profiles/${saved.json.id}/delete`, {})
        assert.equal(removed.status, 200, removed.text)
        assert.notEqual(app.runtime.provider.model, 'gemini-a', 'deleting the active connection falls back to the environment')
        assert.equal((await app.call('/model')).json.active, null)

        const bad = await app.call('/model/profiles', { preset: 'custom', baseUrl: 'http://example.com', model: 'x', apiKey: 'k' })
        assert.equal(bad.status, 400)
    } finally {
        await app.close()
        rmSync(dir, { recursive: true, force: true })
    }
})

test('developer mode edits go through Policy and the audit log', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cl-dev-'))
    const app = await boot(dir)
    try {
        const identity = app.runtime.identityService.resolveOrCreate('sillytavern', 'user', '用户')
        const id = identity.instance.id
        const dev = (op: string, body: Record<string, unknown>) => app.call(`/instances/${id}/dev/${op}`, body)

        assert.equal((await dev('condition', { mood: '雀跃', energy: 0.9 })).status, 200)
        let s = (await app.call(`/instances/${id}/semantics`)).json
        assert.equal(s.self.condition.mood.label, '雀跃')
        assert.equal(s.self.condition.energy, 0.9)

        assert.equal((await dev('goal-upsert', { title: '修好那本书', progress: 0.2 })).status, 200)
        s = (await app.call(`/instances/${id}/semantics`)).json
        const goal = s.motivation.goals.find((item: { title: string }) => item.title === '修好那本书')
        assert.ok(goal)
        assert.equal((await dev('goal-delete', { id: goal.id })).status, 200)

        const added = await dev('memory-add', { title: '后台写入', content: '用户喜欢下雨天', kind: 'user', status: 'fact', tags: 'weather, 偏好' })
        assert.equal(added.status, 200, added.text)
        const edited = await dev('memory-edit', { id: added.json.id, title: '后台改写', content: '用户喜欢雷雨天' })
        assert.equal(edited.status, 200, edited.text)
        const memories = (await app.call(`/instances/${id}/memories?deleted=1`)).json as Array<{ id: string; title: string; deletedAtSim: number | null; sourceRef: string | null }>
        assert.ok(memories.find(item => item.id === added.json.id)?.deletedAtSim !== null, 'the old version is soft-deleted')
        assert.equal(memories.find(item => item.id === edited.json.id)?.sourceRef, `console:supersedes:${added.json.id}`)

        assert.equal((await dev('fact-set', { key: 'weather', value: 'rain' })).status, 200)
        assert.equal((await dev('fact-set', { key: 'lamp_on', value: 'true' })).status, 200)
        s = (await app.call(`/instances/${id}/semantics`)).json
        assert.equal(s.situation.facts.weather, 'rain')
        assert.equal(s.situation.facts.lamp_on, true)
        assert.equal((await dev('fact-delete', { key: 'weather' })).status, 200)
        s = (await app.call(`/instances/${id}/semantics`)).json
        assert.equal('weather' in s.situation.facts, false)
        assert.equal(s.situation.facts.lamp_on, true, 'other facts survive a delete')

        assert.equal((await dev('condition', { energy: 7 })).status, 400)
        assert.equal((await dev('fact-set', { key: 'reset', value: true })).status, 400)
        assert.equal((await dev('nope', {})).status, 400)

        const audit = (await app.call(`/instances/${id}/audit?limit=200`)).json as Array<{ type: string; actor: string }>
        assert.ok(audit.some(event => event.type === 'proposal_applied' && event.actor === 'owner'))
        assert.ok(audit.some(event => event.type === 'memory_written' && event.actor === 'owner'))
    } finally {
        await app.close()
        rmSync(dir, { recursive: true, force: true })
    }
})
