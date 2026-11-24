/**
 * Validate a character pack and print what CharacterLife will load.
 *
 *   npm run pack:check -- characters/shen-zhiwei
 *
 * Exit code 0 when the pack is valid, 1 when it has problems (all of them are listed).
 */

import { CharacterPackError, loadCharacterPack, packModelId } from '../src/character/pack.ts'

const target = process.argv[2]
if (!target) {
  console.error('Usage: npm run pack:check -- <pack directory or character.json>')
  process.exit(2)
}

try {
  const pack = loadCharacterPack(target)
  const { manifest, template, files } = pack
  console.log(`OK  ${manifest.name} (${manifest.id}@${manifest.version}, ${manifest.language}, ${manifest.license})`)
  console.log(`    model id     ${packModelId(manifest)}`)
  console.log(`    template     ${template.id}@${template.version} ${template.contentHash.slice(0, 16)}…`)
  console.log(`    timeline     ${template.timeline.length} event(s)`)
  console.log(`    portrait     ${files.portrait ? 'yes' : 'no'}; expressions: ${Object.keys(files.expressions).join(', ') || 'none'}`)
  console.log(`    knowledge    ${files.knowledge.length} file(s)`)
  console.log('Changing the pack later? Raise "version" (npm run studio does it); existing conversations move to it at the next start.')
} catch (error) {
  if (error instanceof CharacterPackError) {
    console.error(error.message)
    console.error(`${error.issues.length} problem(s).`)
    process.exit(1)
  }
  throw error
}
