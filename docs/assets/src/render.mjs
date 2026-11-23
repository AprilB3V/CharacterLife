// Render README artwork (HTML -> PNG) with a local Chromium-based browser in headless mode.
// Usage: node docs/assets/src/render.mjs [name ...]
// Set BROWSER to the browser executable if Edge is not at its default Windows path.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC_DIR = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = resolve(SRC_DIR, '..')
const BROWSER = process.env.BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'

// Page name -> viewport height (width is fixed at 1600 CSS px).
const PAGES = { banner: 700, concept: 960, status: 960 }

const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PAGES)
for (const name of names) {
    const height = PAGES[name]
    if (!height) throw new Error(`Unknown page: ${name}`)
    const profile = mkdtempSync(join(tmpdir(), 'cl-render-'))
    const out = join(OUT_DIR, `${name}.png`)
    try {
        execFileSync(BROWSER, [
            '--headless=new',
            '--disable-gpu',
            '--hide-scrollbars',
            '--force-device-scale-factor=1',
            `--user-data-dir=${profile}`,
            `--window-size=1600,${height}`,
            `--screenshot=${out}`,
            pathToFileURL(join(SRC_DIR, `${name}.html`)).href,
        ], { stdio: 'ignore' })
    } finally {
        rmSync(profile, { recursive: true, force: true })
    }
    console.log(`wrote ${out}`)
}
