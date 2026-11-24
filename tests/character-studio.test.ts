import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStudioServer } from '../src/studio/server.ts'
import { MockProvider } from '../src/conversation/providers/mock.ts'

const SHEN_DIR = fileURLToPath(new URL('../characters/shen-zhiwei/', import.meta.url))
const TOKEN = 'studio-test-token-0123456789'

/** Raw request so tests can set Host and Origin, which fetch refuses to forge. */
async function call(port: number, method: string, path: string, opts: { cookie?: boolean; host?: string; origin?: string; body?: unknown } = {}) {
  const body = opts.body === undefined ? undefined : Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(JSON.stringify(opts.body))
  return await new Promise<{ status: number; headers: Record<string, unknown>; text: string; json: any }>((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port, method, path,
      headers: {
        host: opts.host ?? `127.0.0.1:${port}`,
        ...(opts.cookie === false ? {} : { cookie: `cl_studio=${TOKEN}` }),
        ...(opts.origin ? { origin: opts.origin } : {}),
        ...(body ? { 'content-type': 'application/json', 'content-length': body.length } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json: unknown = null
        try { json = JSON.parse(text) } catch { /* html or text */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json })
      })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function cardPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(8)
    head.writeUInt32BE(data.length, 0)
    head.write(type, 4, 'latin1')
    return Buffer.concat([head, data, Buffer.alloc(4)])
  }
  const card = { spec: 'chara_card_v2', data: { name: 'Mara Lin', description: 'A night courier.', personality: 'dry, loyal' } }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
    chunk('tEXt', Buffer.from(`chara\0${Buffer.from(JSON.stringify(card)).toString('base64')}`, 'latin1')),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

test('the studio only serves its own page to the holder of the link', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cl-studio-'))
  const studio = createStudioServer({ charactersDir: root, token: TOKEN, port: 0 })
  try {
    const { openUrl } = await studio.listen()
    const port = Number(new URL(openUrl).port)
    const open = await call(port, 'GET', `/?token=${TOKEN}`, { cookie: false })
    assert.equal(open.status, 303)
    assert.match(String(open.headers['set-cookie']), /cl_studio=.*HttpOnly; SameSite=Strict/)
    assert.equal((await call(port, 'GET', '/?token=wrong', { cookie: false })).status, 403)
    assert.equal((await call(port, 'GET', '/', { cookie: false })).status, 403)
    const page = await call(port, 'GET', '/')
    assert.equal(page.status, 200)
    assert.match(page.text, /角色工作室/)
    assert.equal((await call(port, 'GET', '/api/state', { cookie: false })).status, 401)
    assert.equal((await call(port, 'GET', '/api/state', { host: `evil.example:${port}` })).status, 403, 'DNS rebinding')
    assert.equal((await call(port, 'POST', '/api/blank', { origin: 'http://evil.example', body: {} })).status, 403, 'cross-origin write')
    const state = await call(port, 'GET', '/api/state')
    assert.deepEqual(state.json.characters, [])
    assert.equal(state.json.draftModel, null)
  } finally {
    await studio.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('import a card, save it, edit it: files land in the pack and versions bump', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cl-studio-'))
  cpSync(SHEN_DIR, join(root, 'shen-zhiwei'), { recursive: true })
  const studio = createStudioServer({ charactersDir: root, token: TOKEN, port: 0, provider: new MockProvider({ mode: 'in-character' }) })
  try {
    const { openUrl } = await studio.listen()
    const port = Number(new URL(openUrl).port)
    const origin = `http://127.0.0.1:${port}`

    const imported = await call(port, 'POST', '/api/import-card', { origin, body: cardPng() })
    assert.equal(imported.status, 200, imported.text)
    assert.equal(imported.json.manifest.id, 'mara-lin')
    assert.match(imported.json.portrait, /^data:image\/png;base64,/)

    const saved = await call(port, 'POST', '/api/characters', { origin, body: { manifest: imported.json.manifest, pendingId: imported.json.pendingId, create: true } })
    assert.equal(saved.status, 200, saved.text)
    assert.deepEqual([saved.json.version, saved.json.created, saved.json.model], [1, true, 'characterlife/mara-lin'])
    assert.ok(existsSync(join(root, 'mara-lin', 'portrait.png')))
    assert.ok(existsSync(join(root, 'mara-lin', 'knowledge', 'card.md')))

    const again = await call(port, 'POST', '/api/characters', { origin, body: { manifest: imported.json.manifest, create: true } })
    assert.equal(again.status, 409, 'creating over an existing id is refused')

    const loaded = await call(port, 'GET', '/api/characters/mara-lin')
    const manifest = loaded.json.manifest
    manifest.profile.values = ['always deliver']
    const edited = await call(port, 'POST', '/api/characters', { origin, body: { manifest } })
    assert.deepEqual([edited.json.version, edited.json.bumped], [2, true])

    manifest.profile.traits = []
    const invalid = await call(port, 'POST', '/api/characters', { origin, body: { manifest } })
    assert.equal(invalid.status, 422)
    assert.ok(invalid.json.error.issues.some((i: { path: string }) => i.path === 'profile.traits'))
    const issues = await call(port, 'POST', '/api/validate', { origin, body: { manifest } })
    assert.ok(issues.json.issues.some((i: { path: string }) => i.path === 'profile.traits'))

    const state = await call(port, 'GET', '/api/state')
    assert.deepEqual(state.json.characters.map((c: { id: string }) => c.id), ['mara-lin', 'shen-zhiwei'])
    assert.equal(state.json.draftModel, null, 'the mock provider does not count as a draft model')
    assert.equal((await call(port, 'POST', '/api/draft', { origin, body: { description: 'A lighthouse keeper who talks to ships.' } })).status, 503)
    const portrait = await call(port, 'GET', '/api/characters/mara-lin/portrait')
    assert.equal(portrait.status, 200)
    assert.equal(portrait.headers['content-type'], 'image/png')
    assert.equal((await call(port, 'GET', '/api/characters/..%2Fsecret')).status, 404)
    assert.equal(JSON.parse(readFileSync(join(root, 'shen-zhiwei', 'character.json'), 'utf8')).version, 1, 'other packs untouched')
  } finally {
    await studio.close()
    rmSync(root, { recursive: true, force: true })
  }
})
