import test from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CharacterPackError, loadCharacterPack } from '../src/character/pack.ts'
import type { CharacterPackManifest } from '../src/character/pack.ts'
import { saveCharacterPack, scanCharacterPacks } from '../src/character/pack-library.ts'
import { assembleRuntime } from '../src/api/runtime-factory.ts'
import { createApiServer } from '../src/api/server.ts'
import { createCharacterRouter } from '../src/api/character-router.ts'
import { MockProvider } from '../src/conversation/providers/mock.ts'
import { loadCharacterLibrary, prepareCharacterDatabase } from '../examples/character-module.ts'

const SHEN_DIR = fileURLToPath(new URL('../characters/shen-zhiwei/', import.meta.url))
const TOKEN = 'library-test-token'

function shen(): CharacterPackManifest {
  return JSON.parse(readFileSync(join(SHEN_DIR, 'character.json'), 'utf8')) as CharacterPackManifest
}

function courier(): CharacterPackManifest {
  const m = shen()
  m.id = 'test-courier'
  m.name = 'Mara'
  m.profile.name = 'Mara'
  m.profile.speechStyle = 'Short, dry sentences.'
  return m
}

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function openRuntime(dbPath: string, dir: string) {
  return assembleRuntime({
    dbPath,
    template: loadCharacterPack(dir).template,
    worldId: 'world_test',
    auditFile: null,
    provider: new MockProvider({ mode: 'in-character' }),
    thinkProvider: null,
  })
}

async function chat(url: string, model: string, content: string): Promise<Response> {
  return await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content }] }),
  })
}

test('saving a pack bumps the version only when the character changes', () => {
  const root = tempDir('cl-lib-')
  try {
    const first = saveCharacterPack(root, { ...courier(), version: 7 })
    assert.equal(first.created, true)
    assert.equal(first.manifest.version, 1, 'a new pack starts at 1 whatever the caller sent')

    const meta = courier()
    meta.summary = 'A courier who never misses a delivery.'
    const second = saveCharacterPack(root, meta)
    assert.deepEqual([second.created, second.bumped, second.manifest.version], [false, false, 1])

    const edited = courier()
    edited.profile.speechStyle = 'Warm and chatty.'
    const third = saveCharacterPack(root, edited)
    assert.deepEqual([third.bumped, third.manifest.version], [true, 2])
    assert.equal(loadCharacterPack(join(root, 'test-courier')).manifest.version, 2)

    const broken = courier()
    broken.profile.traits = []
    assert.throws(() => saveCharacterPack(root, broken), (error: unknown) =>
      error instanceof CharacterPackError && error.issues.some((i) => i.path === 'profile.traits'))
    assert.equal(loadCharacterPack(join(root, 'test-courier')).manifest.version, 2, 'a rejected save writes nothing')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the library runs every pack, keeps the built-in database and skips broken packs', async () => {
  const root = tempDir('cl-lib-')
  try {
    cpSync(SHEN_DIR, join(root, 'shen-zhiwei'), { recursive: true })
    saveCharacterPack(root, courier())
    mkdirSync(join(root, 'broken'))
    writeFileSync(join(root, 'broken', 'character.json'), '{ nope')
    const db = join(root, 'data', 'characterlife.db')
    const library = await loadCharacterLibrary(db, { CHARACTERLIFE_CHARACTERS_DIR: root })
    assert.deepEqual(library.entries.map((e) => e.modelId), ['characterlife/shen-zhiwei', 'characterlife/test-courier'])
    assert.equal(library.entries[0]!.dbPath, db)
    assert.equal(library.entries[1]!.dbPath, join(root, 'data', 'test-courier.db'))
    assert.equal(library.skipped.length, 1)
    assert.match(library.skipped[0]!, /broken/)
    assert.equal(scanCharacterPacks(join(root, 'missing')).packs.length, 0)

    const chosen = await loadCharacterLibrary(db, { CHARACTERLIFE_CHARACTERS_DIR: root, CHARACTERLIFE_DEFAULT_CHARACTER: 'test-courier' })
    assert.equal(chosen.entries[0]!.modelId, 'characterlife/test-courier')
    await assert.rejects(loadCharacterLibrary(db, { CHARACTERLIFE_CHARACTERS_DIR: root, CHARACTERLIFE_DEFAULT_CHARACTER: 'nobody' }), /not in/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('one endpoint serves each character from its own database, picked by model', async () => {
  const root = tempDir('cl-lib-')
  cpSync(SHEN_DIR, join(root, 'shen-zhiwei'), { recursive: true })
  saveCharacterPack(root, courier())
  const runtimes = [
    openRuntime(join(root, 'shen.db'), join(root, 'shen-zhiwei')),
    openRuntime(join(root, 'courier.db'), join(root, 'test-courier')),
  ]
  const models = ['characterlife/shen-zhiwei', 'characterlife/test-courier']
  const listedModels = models.map((id) => ({ id, label: id }))
  const apis = runtimes.map((runtime, i) =>
    createApiServer({ runtime, token: TOKEN, port: 0, modelId: models[i], listedModels, logger: () => {} }))
  const router = createCharacterRouter({
    characters: models.map((modelId, i) => ({ modelId, label: modelId, api: apis[i]! })),
    port: 0,
  })
  try {
    const { url } = await router.listen()
    const list = await fetch(`${url}/v1/models`, { headers: { authorization: `Bearer ${TOKEN}` } })
    assert.deepEqual(((await list.json()) as { data: Array<{ id: string }> }).data.map((m) => m.id), models)

    const toCourier = await chat(url, 'characterlife/test-courier', 'Hello Mara')
    assert.equal(toCourier.status, 200)
    assert.equal(runtimes[1]!.persistence.listInstances().length, 1)
    assert.equal(runtimes[0]!.persistence.listInstances().length, 0, 'the other character never saw it')

    const fallback = await chat(url, 'gpt-4o', 'Hello')
    assert.equal(fallback.status, 200)
    assert.equal(runtimes[0]!.persistence.listInstances().length, 1, 'non-CharacterLife names go to the default')

    const unknown = await chat(url, 'characterlife/nobody', 'Hello')
    assert.equal(unknown.status, 404)
    assert.equal(((await unknown.json()) as { error: { code: string } }).error.code, 'MODEL_NOT_FOUND')

    const unauthorized = await fetch(`${url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'characterlife/test-courier', messages: [{ role: 'user', content: 'hi' }] }),
    })
    assert.equal(unauthorized.status, 401, 'each character still checks the token')
  } finally {
    await router.close()
    for (const runtime of runtimes) runtime.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('editing a character moves existing conversations onto the new version', async () => {
  const root = tempDir('cl-lib-')
  const db = join(root, 'courier.db')
  saveCharacterPack(root, courier())
  const packDir = join(root, 'test-courier')
  try {
    const first = openRuntime(db, packDir)
    const api = createApiServer({ runtime: first, token: TOKEN, port: 0, logger: () => {} })
    const { url } = await api.listen()
    assert.equal((await chat(url, 'characterlife/test-courier', 'My name is Ada.')).status, 200)
    await api.close()
    const [instance] = first.persistence.listInstances()
    first.close()

    const edited = courier()
    edited.profile.speechStyle = 'Warm and chatty.'
    assert.equal(saveCharacterPack(root, edited).manifest.version, 2)

    // Opted out: the server reports why instead of answering with errors.
    const strict = openRuntime(db, packDir)
    const refused = prepareCharacterDatabase(strict, db, { CHARACTERLIFE_AUTO_MIGRATE: 'false' })
    assert.equal(refused.upgrades.length, 0)
    assert.match(refused.problem ?? '', /moved from version 1 to 2/)
    strict.close()

    const second = openRuntime(db, packDir)
    const prepared = prepareCharacterDatabase(second, db, {})
    assert.deepEqual(prepared.upgrades, [{ instanceId: instance!.id, from: 1, to: 2 }])
    assert.equal(prepared.problem, null)
    const migrated = second.persistence.getInstance(instance!.id)!
    assert.equal(migrated.templateVersion, 2)
    assert.equal(migrated.templateHash, second.template.contentHash)

    const again = createApiServer({ runtime: second, token: TOKEN, port: 0, logger: () => {} })
    const reopened = await again.listen()
    const reply = await chat(reopened.url, 'characterlife/test-courier', 'Do you remember me?')
    assert.equal(reply.status, 200, 'the migrated conversation restores and answers')
    assert.equal(second.persistence.listInstances().length, 1, 'same relationship, not a new one')
    assert.equal(second.runtimeManager.get(instance!.id).workspace.profile.speechStyle, 'Warm and chatty.')
    await again.close()
    second.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
