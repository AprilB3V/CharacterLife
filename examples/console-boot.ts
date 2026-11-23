/**
 * Start the owner console next to a chat entry when CHARACTERLIFE_CONSOLE_TOKEN is set.
 *
 * The console runs in the same process as the entry so it reads the live runtime (thought
 * traces live in memory) and never opens the database a second time.
 *
 *   CHARACTERLIFE_CONSOLE_TOKEN   console Bearer token, at least 16 characters (unset: no console)
 *   CHARACTERLIFE_CONSOLE_PORT    loopback port, default 8788
 */

import { createConsoleServer } from '../src/console/server.ts'
import type { ConsoleServerHandle } from '../src/console/server.ts'
import type { RuntimeBundle } from '../src/api/runtime-factory.ts'

export async function bootConsole(runtime: RuntimeBundle, env: NodeJS.ProcessEnv = process.env): Promise<ConsoleServerHandle | null> {
  const token = env.CHARACTERLIFE_CONSOLE_TOKEN?.trim()
  if (!token) return null
  if (token.length < 16) {
    console.error('⚠ CHARACTERLIFE_CONSOLE_TOKEN 少于 16 个字符，后台未启动')
    return null
  }
  const port = Number(env.CHARACTERLIFE_CONSOLE_PORT ?? 8788)
  const handle = createConsoleServer({ runtime, token, port: Number.isInteger(port) && port > 0 ? port : 8788 })
  try {
    const { url } = await handle.listen()
    console.log(`主人后台：${url}（令牌见 CHARACTERLIFE_CONSOLE_TOKEN；思维链在「思维链」页）`)
    return handle
  } catch (err) {
    console.error(`⚠ 后台启动失败：${(err as Error).message}`)
    return null
  }
}
