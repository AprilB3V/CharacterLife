import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CharacterPackError,
  formatPackDuration,
  loadCharacterPack,
  packModelId,
  parsePackDuration,
  validatePackManifest,
} from '../src/character/pack.ts'
import { checkTemplateVersion } from '../src/character/template.ts'
import { assembleRuntime, defaultTemplate } from '../src/api/runtime-factory.ts'
import { describeTemplateMismatch, loadCharacterFromEnv } from '../examples/character-module.ts'

const SHEN_DIR = new URL('../characters/shen-zhiwei/', import.meta.url)
const shenManifest = () => JSON.parse(readFileSync(new URL('character.json', SHEN_DIR), 'utf8'))

function tempPack(manifest: unknown, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'cl-pack-'))
  writeFileSync(join(dir, 'character.json'), JSON.stringify(manifest))
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true })
    writeFileSync(join(dir, rel), content)
  }
  return dir
}

test('the Shen Zhiwei pack builds exactly the built-in template', () => {
  const pack = loadCharacterPack(fileURLToPath(SHEN_DIR))
  const builtIn = defaultTemplate()
  assert.equal(pack.template.contentHash, builtIn.contentHash)
  assert.equal(pack.template.id, 'char_shen_zhiwei')
  assert.equal(packModelId(pack.manifest), 'characterlife/shen-zhiwei')
  // Instances created with the built-in template restore against the pack.
  const check = checkTemplateVersion(pack.template, {
    templateId: builtIn.id,
    templateVersion: builtIn.version,
    templateHash: builtIn.contentHash,
  })
  assert.equal(check.ok, true, check.detail)
  assert.ok(Object.isFrozen(pack.template.profile))
})

test('durations round-trip', () => {
  for (const ms of [0, 9 * 3_600_000, 26 * 3_600_000, (2 * 24 * 60 + 30) * 60_000]) {
    assert.equal(parsePackDuration(formatPackDuration(ms)), ms)
  }
  assert.equal(parsePackDuration('1d2h30m'), (26 * 60 + 30) * 60_000)
  for (const bad of ['', 'h', '2x', '-1h', '1.5h', '2h1d']) assert.equal(parsePackDuration(bad), null, bad)
})

test('validation lists every problem with its path', () => {
  const m = shenManifest()
  m.id = 'Shen Zhiwei'
  m.license = ''
  delete m.voice.proactive.life_update
  m.profile.traits = []
  m.profile.mood = 'happy'
  m.timeline[1].at = 'soon'
  m.timeline[2].id = m.timeline[0].id
  const paths = validatePackManifest(m).map((i) => i.path).sort()
  assert.deepEqual(paths, [
    'id',
    'license',
    'profile.mood',
    'profile.traits',
    'timeline[1].at',
    'timeline[2].id',
    'voice.proactive.life_update',
  ])
})

test('pack files must stay inside the pack and exist', () => {
  const m = shenManifest()
  m.assets = { portrait: '../outside.png', expressions: { neutral: 'art/neutral.png', smile: 'art/missing.png' } }
  m.knowledge = ['C:/secrets.md']
  const issues = validatePackManifest(m).map((i) => i.path).sort()
  assert.deepEqual(issues, ['assets.portrait', 'knowledge[0]'])

  m.assets.portrait = 'art/portrait.png'
  m.knowledge = ['notes/world.md']
  const dir = tempPack(m, { 'art/portrait.png': 'x', 'art/neutral.png': 'x', 'notes/world.md': '# world' })
  try {
    assert.throws(() => loadCharacterPack(dir), (error: unknown) => {
      assert.ok(error instanceof CharacterPackError)
      assert.deepEqual(error.issues.map((i) => i.path), ['assets.expressions.smile'])
      return true
    })
    delete m.assets.expressions.smile
    writeFileSync(join(dir, 'character.json'), JSON.stringify(m))
    const pack = loadCharacterPack(join(dir, 'character.json'))
    assert.ok(pack.files.portrait?.endsWith('portrait.png'))
    assert.deepEqual(Object.keys(pack.files.expressions), ['neutral'])
    assert.equal(pack.files.knowledge.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('broken JSON and missing manifests are reported, not thrown raw', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cl-pack-'))
  try {
    assert.throws(() => loadCharacterPack(dir), CharacterPackError)
    writeFileSync(join(dir, 'character.json'), '{ "packFormat": 1, ')
    assert.throws(() => loadCharacterPack(dir), /not valid JSON/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a new pack runs in the runtime and a changed pack needs a version bump', async () => {
  const m = shenManifest()
  m.id = 'test-courier'
  m.name = 'Test Courier'
  m.language = 'en'
  m.profile.name = 'Mara'
  m.profile.speechStyle = 'Short, dry sentences.'
  const dir = tempPack(m)
  const dbDir = mkdtempSync(join(tmpdir(), 'cl-pack-db-'))
  try {
    const character = await loadCharacterFromEnv({ CHARACTERLIFE_CHARACTER_PACK: dir })
    assert.equal(character.modelId, 'characterlife/test-courier')
    assert.equal(character.template?.id, 'char_test_courier')
    const runtime = assembleRuntime({ dbPath: join(dbDir, 'a.db'), template: character.template, auditFile: null, worldId: 'world_test' })
    assert.equal(runtime.template.profile.name, 'Mara')
    assert.equal(describeTemplateMismatch(runtime.persistence, runtime.template, 'a.db'), null)
    // Simulate a conversation so the database holds an instance bound to this template.
    runtime.persistence.createInstance({ template: runtime.template, playerId: 'p1', worldId: 'w' }, 'inst_test', new Date().toISOString())
    runtime.close()

    // Same id and version, different content: the hash no longer matches what instances recorded.
    m.profile.speechStyle = 'Long, florid sentences.'
    writeFileSync(join(dir, 'character.json'), JSON.stringify(m))
    const changed = loadCharacterPack(dir).template
    const original = character.template!
    const check = checkTemplateVersion(changed, {
      templateId: original.id,
      templateVersion: original.version,
      templateHash: original.contentHash,
    })
    assert.equal(check.code, 'HASH_MISMATCH')

    // The servers refuse to start on that database and say why.
    const reopened = assembleRuntime({ dbPath: join(dbDir, 'a.db'), template: changed, auditFile: null, worldId: 'world_test' })
    assert.match(describeTemplateMismatch(reopened.persistence, changed, 'a.db') ?? '', /"version" is still 1/)
    reopened.close()
    m.id = 'someone-else'
    writeFileSync(join(dir, 'character.json'), JSON.stringify(m))
    const other = loadCharacterPack(dir).template
    const third = assembleRuntime({ dbPath: join(dbDir, 'a.db'), template: other, auditFile: null, worldId: 'world_test' })
    assert.match(describeTemplateMismatch(third.persistence, other, 'a.db') ?? '', /belongs to another character \(char_test_courier\)/)
    third.close()

    await assert.rejects(
      loadCharacterFromEnv({ CHARACTERLIFE_CHARACTER_PACK: dir, CHARACTERLIFE_CHARACTER_MODULE: 'x.ts' }),
      /not both/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(dbDir, { recursive: true, force: true })
  }
})
