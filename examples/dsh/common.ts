/**
 * Shared helpers for the dsh (DeepSeek Harness) integration scripts. See docs/DSH.md.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const DSH_PROFILE = process.env.CHARACTERLIFE_DSH_PROFILE?.trim() || 'characterlife'
export const BUNDLE_NAME = 'characterlife-dsh'
export const BUNDLE_DIR = resolve(import.meta.dirname, '../../integrations/dsh')

export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_HOME?.trim() || join(homedir(), '.dsh')
}

export function profileDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(dshHome(env), 'profiles', DSH_PROFILE)
}

/** Quote one argument for a cmd.exe / sh command line. */
export function quote(arg: string): string {
  return /^[\w@:/.\\=-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`
}

/** Run `dsh ...` (a .cmd shim on Windows, so it goes through the shell). */
export function runDsh(args: string[], opts: { inherit?: boolean } = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(['dsh', ...args.map(quote)].join(' '), {
    shell: true,
    encoding: 'utf8',
    stdio: opts.inherit ? 'inherit' : 'pipe',
    windowsHide: true,
  })
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

export function dshVersion(): string | null {
  const result = runDsh(['--version'])
  return result.status === 0 ? result.stdout.trim() : null
}

/** True when the profile's link to integrations/dsh still resolves (it breaks if the repository moves). */
export function bundleLinked(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(join(profileDir(env), 'node_modules', BUNDLE_NAME, 'characterlife.patch.yml'))
}

/** Bundle names listed in the profile's package.json, or null when the profile does not exist. */
export function profileBundles(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const file = join(profileDir(env), 'package.json')
  if (!existsSync(file)) return null
  try {
    const pkg = JSON.parse(readFileSync(file, 'utf8'))
    const bundles = pkg?.dsh?.profile?.bundles
    return Array.isArray(bundles) ? bundles.filter((b: unknown): b is string => typeof b === 'string') : []
  } catch {
    return []
  }
}
