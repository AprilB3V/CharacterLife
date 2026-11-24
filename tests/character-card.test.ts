import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { validatePackManifest } from '../src/character/pack.ts'
import { saveCharacterPack } from '../src/character/pack-library.ts'
import { blankPack, draftFromDescription, guessLanguage, mergeDraft, packIdFromName } from '../src/character/pack-draft.ts'
import { CardError, importCharacterCard, pngTextChunks } from '../src/character/st-card.ts'
import type { LLMProvider, LLMRequest } from '../src/kernel/types.ts'

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  return Buffer.concat([head, data, Buffer.alloc(4)])
}

/** A 1×1 PNG with the card in a text chunk, the way SillyTavern exports it. */
function cardPng(card: unknown, keyword = 'chara', compressed = false): Buffer {
  const encoded = Buffer.from(JSON.stringify(card)).toString('base64')
  const ihdr = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])
  const text = compressed
    ? chunk('zTXt', Buffer.concat([Buffer.from(`${keyword}\0\0`, 'latin1'), deflateSync(Buffer.from(encoded, 'latin1'))]))
    : chunk('tEXt', Buffer.from(`${keyword}\0${encoded}`, 'latin1'))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    text,
    chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const V2_CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Mara Lin',
    description: '{{char}} is a 31-year-old night-shift courier in a rainy harbour city. She knows every shortcut and keeps a notebook of promises.',
    personality: 'dry, loyal, curious; stubborn',
    scenario: '{{user}} keeps missing deliveries and {{char}} has started leaving notes.',
    first_mes: '*taps the door* Package for {{user}}. Again.',
    mes_example: '<START>\n{{user}}: Why do you walk everywhere?\n{{char}}: Bikes get stolen. Feet do not.\n{{char}}: Sign here.',
    creator_notes: 'A courier who never forgets a promise.\nMore notes here.',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: ['Rain again. Sign here.'],
    tags: ['female', 'courier', 'harbour city', 'NSFW'],
    creator: 'tester',
    character_version: '1',
    extensions: {},
    character_book: { entries: [{ keys: ['harbour'], content: 'The harbour floods every spring.', enabled: true }] },
  },
}

test('a SillyTavern V2 PNG card becomes a valid pack draft with its portrait and extras', () => {
  const png = cardPng(V2_CARD)
  const imported = importCharacterCard(png)
  const m = imported.manifest
  assert.deepEqual(validatePackManifest(m), [])
  assert.equal(m.id, 'mara-lin')
  assert.equal(m.language, 'en')
  assert.equal(m.profile.age, 31)
  assert.match(m.profile.background, /^Mara Lin is a 31-year-old night-shift courier/)
  assert.deepEqual(m.profile.traits, ['dry', 'loyal', 'curious', 'stubborn'])
  assert.deepEqual(m.profile.interests, ['courier', 'harbour city'], 'generic tags are dropped')
  assert.equal(m.profile.relationshipNotes, 'the user keeps missing deliveries and Mara Lin has started leaving notes.')
  assert.equal(m.profile.speechStyle, 'Talks like: 「Bikes get stolen. Feet do not.」 / 「Sign here.」')
  assert.equal(m.summary, 'A courier who never forgets a promise.')
  assert.equal(m.authors[0]!.name, 'tester')
  assert.equal(m.license, 'LicenseRef-Unspecified')
  assert.equal(m.assets?.portrait, 'portrait.png')
  assert.ok(imported.placeholders.includes('profile.values'), 'what the card does not say is flagged')
  assert.ok(!imported.placeholders.includes('profile.background'))
  const notes = Buffer.from(imported.files['knowledge/card.md']!).toString('utf8')
  assert.match(notes, /Package for the user\. Again\./)
  assert.match(notes, /Rain again/)
  assert.match(notes, /The harbour floods every spring/)

  const root = mkdtempSync(join(tmpdir(), 'cl-card-'))
  try {
    const saved = saveCharacterPack(root, m, imported.files)
    assert.equal(saved.created, true)
    assert.equal(readFileSync(join(saved.dir, 'portrait.png')).length, png.length)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('V1 JSON, V3 and compressed chunks are read; broken files say why', () => {
  const v1 = importCharacterCard(Buffer.from(JSON.stringify({
    name: '林雾', description: '林雾，二十出头，在旧城区开一家修表铺。她话不多，但答应的事一定做到。', personality: '安静、固执、心软',
    scenario: '', first_mes: '……表修好了。', mes_example: '',
  })))
  assert.equal(v1.card.spec, 'v1')
  assert.equal(v1.manifest.language, 'zh-CN')
  assert.match(v1.manifest.id, /^oc-[0-9a-f]{8}$/)
  assert.deepEqual(v1.manifest.profile.traits, ['安静', '固执', '心软'])
  assert.equal(v1.manifest.assets, undefined, 'JSON cards have no image')
  assert.deepEqual(validatePackManifest(v1.manifest), [])

  const v3 = importCharacterCard(cardPng({ ...V2_CARD, spec: 'chara_card_v3', spec_version: '3.0' }, 'ccv3', true))
  assert.equal(v3.card.spec, 'v3')
  assert.equal(v3.manifest.name, 'Mara Lin')

  assert.ok(pngTextChunks(cardPng(V2_CARD)).has('chara'))
  assert.throws(() => importCharacterCard(cardPng(V2_CARD, 'other')), CardError)
  assert.throws(() => importCharacterCard(Buffer.from('not json')), /neither a PNG card nor JSON/)
  assert.throws(() => importCharacterCard(Buffer.from('{"description":"x"}')), /no name/)
})

test('ids and languages are guessed sensibly', () => {
  assert.equal(packIdFromName('Mara Lin'), 'mara-lin')
  assert.equal(packIdFromName('Zoë  O\'Brien!'), 'zoe-o-brien')
  assert.equal(packIdFromName('沈知微'), packIdFromName('沈知微'), 'stable')
  assert.equal(guessLanguage('她在旧城区开修表铺'), 'zh-CN')
  assert.equal(guessLanguage('A courier in the rain'), 'en')
  assert.deepEqual(validatePackManifest(blankPack('', 'en').manifest), [])
  assert.deepEqual(validatePackManifest(blankPack('新角色', 'zh-CN').manifest), [])
})

test('a model draft fills what it can and keeps placeholders for the rest', async () => {
  let seen: LLMRequest | null = null
  const provider: LLMProvider = {
    name: 'fake',
    model: 'fake',
    async complete(request) {
      seen = request
      return {
        text: 'Here you go:\n```json\n' + JSON.stringify({
          name: 'Ada Wren', age: 'old', occupation: 'lighthouse keeper', background: 'Keeps the last manual lighthouse running.',
          traits: ['patient', 'wry'], values: ['keep the light on'], interests: ['weather', 'radio'],
          speechStyle: 'Slow and precise.', relationshipNotes: 'Warms up to people who show up twice.',
          summary: 'The last lighthouse keeper.', proactive: { idle_check_in: ['Fog tonight.'] },
        }) + '\n```',
        provider: 'fake', model: 'fake', usage: null, latencyMs: 1,
      }
    },
  }
  const draft = await draftFromDescription(provider, 'An old lighthouse keeper who talks to ships on the radio.')
  assert.equal(seen!.jsonMode, true)
  assert.match(seen!.system, /English/)
  assert.equal(draft.manifest.name, 'Ada Wren')
  assert.equal(draft.manifest.id, 'ada-wren')
  assert.equal(draft.manifest.profile.occupation, 'lighthouse keeper')
  assert.equal(draft.manifest.voice.proactive.idle_check_in[0], 'Fog tonight.')
  assert.deepEqual(validatePackManifest(draft.manifest), [])
  assert.ok(draft.placeholders.includes('profile.age'), 'a non-numeric age stays a placeholder')
  assert.ok(draft.placeholders.includes('voice.proactive'), 'partial proactive lines keep the rest default')
  assert.ok(!draft.placeholders.includes('profile.traits'))

  const junk = mergeDraft(blankPack('X', 'en'), { traits: 'not a list', background: 42 })
  assert.deepEqual(validatePackManifest(junk.manifest), [])
  await assert.rejects(draftFromDescription(provider, 'short'), /too short/)
})
