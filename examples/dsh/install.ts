/**
 * Create the dsh profile "characterlife" and install the bundle in integrations/dsh.
 * Safe to run again: existing steps are skipped. See docs/DSH.md.
 *
 *   npm run dsh:install
 */

import { BUNDLE_DIR, BUNDLE_NAME, DSH_PROFILE, bundleLinked, dshVersion, profileBundles, profileDir, runDsh } from './common.ts'

const version = dshVersion()
if (!version) {
  console.error('❌ dsh was not found on PATH. Install DeepSeek Harness first, then run this again.')
  process.exit(2)
}
console.log(`dsh ${version}`)

let bundles = profileBundles()
if (bundles === null) {
  // --dump-config makes dsh create the profile from its web template and exit instead of booting it.
  console.log(`Creating dsh profile "${DSH_PROFILE}" from the web template…`)
  const created = runDsh([DSH_PROFILE, '--from-default-profile', 'web', '--dump-config'])
  bundles = profileBundles()
  if (created.status !== 0 || bundles === null) {
    console.error(`❌ Could not create the profile:\n${created.stderr.trim()}`)
    process.exit(1)
  }
}

if (!bundles.includes('@deepseek-ai/dsh-web-app')) {
  console.error(
    `❌ Profile "${DSH_PROFILE}" exists but was not made from the web template (bundles: ${bundles.join(', ') || 'none'}).\n` +
      `   Pick another name with CHARACTERLIFE_DSH_PROFILE, or delete ${profileDir()} and run this again.`,
  )
  process.exit(1)
}

if (bundles.includes(BUNDLE_NAME) && bundleLinked()) {
  console.log(`Bundle ${BUNDLE_NAME} is already installed in "${DSH_PROFILE}".`)
} else {
  console.log(`Installing ${BUNDLE_NAME} from ${BUNDLE_DIR}…`)
  const added = runDsh(['plugin', '--profile', DSH_PROFILE, 'add', `link:${BUNDLE_DIR.replace(/\\/g, '/')}`], { inherit: true })
  if (added.status !== 0 || !profileBundles()?.includes(BUNDLE_NAME)) {
    console.error('❌ dsh did not accept the bundle (see the messages above).')
    process.exit(1)
  }
}

console.log(`\n✅ Ready. Start chatting with:  npm run dsh:chat`)
console.log('   The bundle is linked to this folder; if you move the repository, run npm run dsh:install again.')
