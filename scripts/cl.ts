/**
 * CharacterLife OneBot service control: start, stop, status, logs, owner console, and a local
 * "say" that posts a signed fake QQ message (for a profile that runs against the fake gateway).
 *
 *   scripts\cl.cmd start jingjing          background start, waits for /healthz
 *   scripts\cl.cmd start dev --inspect     with the Node inspector on 127.0.0.1:9229
 *   scripts\cl.cmd stop jingjing           waits for in-flight turns, then stops
 *   scripts\cl.cmd restart jingjing
 *   scripts\cl.cmd status                  every profile
 *   scripts\cl.cmd logs jingjing -f        follow; --errors for error lines only; -n 100
 *   scripts\cl.cmd console jingjing        copy the console token to the clipboard and open it
 *   scripts\cl.cmd say dev 我有本旧书 被水泡过   send messages 1s apart, print the replies
 *
 * A profile is data/profiles/<name>.env (gitignored). Plain lines are passed to the server as
 * environment variables; CTL_* lines are read by this script only:
 *
 *   CTL_LOG=data/onebot-jingjing.log        log file (default data/<name>.log)
 *   CTL_SNOWLUMA_CONFIG=C:\...\onebot.json  read ONEBOT_ACCESS_TOKEN / ONEBOT_SECRET from SnowLuma
 *   CTL_SNOWLUMA_CLIENT=characterlife       name of the HTTP client entry holding the secret
 *   CTL_API_KEY_FROM=ARK_CODING_API_KEY     copy this environment variable into DEEPSEEK_API_KEY
 *   CTL_CONSOLE_TOKEN_FILE=data/console-token.txt   created with a random token if missing
 *   CTL_FAKE_GATEWAY=3999                   start scripts/fake-onebot-gateway.mjs on this port
 *
 * Secrets are never printed. Paths are relative to the repository root.
 */

import { spawn, execFileSync } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE_DIR = join(ROOT, 'data', 'profiles')
const abs = (p: string): string => (isAbsolute(p) ? p : join(ROOT, p))
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

interface Profile {
  name: string
  env: Record<string, string>
  ctl: Record<string, string>
  log: string
  pidFile: string
  gatewayPidFile: string
  gatewayLog: string
  port: number
  host: string
  path: string
  consolePort: number | null
}

function parseEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    let line = raw.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('export ')) line = line.slice(7).trim()
    const eq = line.indexOf('=')
    if (eq < 1) continue
    let value = line.slice(eq + 1).trim()
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1)
    out[line.slice(0, eq).trim()] = value
  }
  return out
}

function listProfiles(): string[] {
  if (!existsSync(PROFILE_DIR)) return []
  return readdirSync(PROFILE_DIR).filter((f) => f.endsWith('.env')).map((f) => f.slice(0, -4)).sort()
}

function loadProfile(name: string | undefined): Profile {
  if (!name) fail(`缺少配置档名。可用：${listProfiles().join(' / ') || '（无，见 scripts/profiles.example/）'}`)
  const file = join(PROFILE_DIR, `${name}.env`)
  if (!existsSync(file)) fail(`找不到配置档 ${file}\n  可以从 scripts/profiles.example/ 复制一份改`)
  const all = parseEnvFile(file)
  const env: Record<string, string> = {}
  const ctl: Record<string, string> = {}
  for (const [k, v] of Object.entries(all)) (k.startsWith('CTL_') ? ctl : env)[k] = v
  const consolePort = env.CHARACTERLIFE_CONSOLE_PORT ?? (ctl.CTL_CONSOLE_TOKEN_FILE ? '8788' : '')
  return {
    name,
    env,
    ctl,
    log: abs(ctl.CTL_LOG ?? `data/${name}.log`),
    pidFile: join(PROFILE_DIR, `${name}.pid`),
    gatewayPidFile: join(PROFILE_DIR, `${name}-gateway.pid`),
    gatewayLog: abs(`data/${name}-gateway.log`),
    port: Number(env.ONEBOT_PORT ?? 8790),
    host: env.ONEBOT_HOST ?? '127.0.0.1',
    path: env.ONEBOT_PATH ?? '/onebot/event',
    consolePort: consolePort ? Number(consolePort) : null,
  }
}

/** Environment for the server process: profile values plus resolved secrets. */
function resolveEnv(p: Profile): Record<string, string> {
  const env: Record<string, string> = { ...p.env }
  if (p.ctl.CTL_SNOWLUMA_CONFIG) {
    const cfg = JSON.parse(readFileSync(abs(p.ctl.CTL_SNOWLUMA_CONFIG), 'utf8'))
    const server = cfg.networks?.httpServers?.[0]
    const clientName = p.ctl.CTL_SNOWLUMA_CLIENT ?? 'characterlife'
    const client = (cfg.networks?.httpClients ?? []).find((c: { name?: string }) => c.name === clientName)
    if (!server?.accessToken) fail('SnowLuma 配置里没有 httpServers[0].accessToken')
    if (!client?.accessToken) fail(`SnowLuma 配置里没有名为 ${clientName} 的 httpClients 项`)
    env.ONEBOT_ACCESS_TOKEN = server.accessToken
    env.ONEBOT_SECRET = client.accessToken
    if (!env.ONEBOT_API_BASE && server.port) env.ONEBOT_API_BASE = `http://127.0.0.1:${server.port}`
  }
  if (p.ctl.CTL_API_KEY_FROM) {
    const key = process.env[p.ctl.CTL_API_KEY_FROM]
    if (!key) fail(`环境变量 ${p.ctl.CTL_API_KEY_FROM} 没有设置（模型 Key 从这里取）`)
    env.DEEPSEEK_API_KEY = key
  }
  if (p.ctl.CTL_CONSOLE_TOKEN_FILE) {
    const file = abs(p.ctl.CTL_CONSOLE_TOKEN_FILE)
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, randomBytes(24).toString('hex'))
      console.log(`已生成后台令牌：${file}`)
    }
    env.CHARACTERLIFE_CONSOLE_TOKEN = readFileSync(file, 'utf8').trim()
    env.CHARACTERLIFE_CONSOLE_PORT ??= String(p.consolePort ?? 8788)
  }
  if (p.ctl.CTL_FAKE_GATEWAY) env.ONEBOT_API_BASE = `http://127.0.0.1:${p.ctl.CTL_FAKE_GATEWAY}`
  return env
}

function fail(message: string): never {
  console.error(`✖ ${message}`)
  process.exit(2)
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readPid(file: string): number | null {
  if (!existsSync(file)) return null
  const pid = Number(readFileSync(file, 'utf8').trim())
  return Number.isInteger(pid) && pid > 0 && pidAlive(pid) ? pid : null
}

/** PID listening on a local port (Windows netstat), for a server started without this script. */
function pidOnPort(port: number): number | null {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' })
    for (const line of out.split(/\r?\n/)) {
      const cols = line.trim().split(/\s+/)
      if (cols[3] === 'LISTENING' && cols[1]?.endsWith(`:${port}`)) return Number(cols[4])
    }
  } catch { /* netstat unavailable */ }
  return null
}

async function health(p: Profile): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`http://${p.host}:${p.port}/healthz`, { signal: AbortSignal.timeout(1500) })
    return res.ok ? ((await res.json()) as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function spawnDetached(args: string[], env: Record<string, string>, log: string): number {
  mkdirSync(dirname(log), { recursive: true })
  const fd = openSync(log, 'a')
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    detached: true,
    stdio: ['ignore', fd, fd],
    windowsHide: true,
  })
  child.unref()
  closeSync(fd)
  return child.pid!
}

async function start(p: Profile, opts: { inspect: boolean }): Promise<void> {
  if ((await health(p)) || readPid(p.pidFile) || pidOnPort(p.port)) {
    fail(`${p.name} 已经在运行（端口 ${p.port}）。要重启用：scripts\\cl.cmd restart ${p.name}`)
  }
  const env = resolveEnv(p)
  if (p.ctl.CTL_FAKE_GATEWAY && !readPid(p.gatewayPidFile)) {
    const gw = spawnDetached([join(ROOT, 'scripts', 'fake-onebot-gateway.mjs'), p.ctl.CTL_FAKE_GATEWAY], {}, p.gatewayLog)
    writeFileSync(p.gatewayPidFile, String(gw))
    console.log(`假网关 pid=${gw} 端口 ${p.ctl.CTL_FAKE_GATEWAY}（日志 ${p.gatewayLog}）`)
  }
  const logStart = existsSync(p.log) ? statSync(p.log).size : 0
  writeFileSync(p.log, `\n===== ${new Date().toISOString()} start ${p.name}${opts.inspect ? ' --inspect' : ''} =====\n`, { flag: 'a' })
  const args = [...(opts.inspect ? ['--inspect=127.0.0.1:9229'] : []), join(ROOT, 'examples', 'onebot', 'server.ts')]
  const pid = spawnDetached(args, env, p.log)
  writeFileSync(p.pidFile, String(pid))
  for (let i = 0; i < 30; i++) {
    await sleep(500)
    if (!pidAlive(pid)) {
      console.error(readFrom(p.log, logStart).trim())
      fail(`${p.name} 启动失败（进程已退出），上面是本次日志`)
    }
    if (await health(p)) {
      const banner = readFrom(p.log, logStart).split(/\r?\n/).filter((l) => l && !l.startsWith('{') && !l.startsWith('====='))
      console.log(banner.join('\n'))
      console.log(`✔ ${p.name} 已启动 pid=${pid}${opts.inspect ? '，调试器 127.0.0.1:9229（VS Code「附加到 Node 进程」或 chrome://inspect）' : ''}`)
      return
    }
  }
  fail(`${p.name} 15 秒内没有就绪，看日志：scripts\\cl.cmd logs ${p.name}`)
}

async function stop(p: Profile, quiet = false): Promise<void> {
  const pid = readPid(p.pidFile) ?? pidOnPort(p.port)
  if (!pid) {
    if (!quiet) console.log(`${p.name} 没在运行`)
  } else {
    // Hard stop on Windows, so first let in-flight turns finish (up to 30s).
    for (let i = 0; i < 60; i++) {
      const h = await health(p)
      if (!h || Number(h.inflight ?? 0) === 0) break
      if (i === 0) console.log('等待在途对话处理完…')
      await sleep(500)
    }
    try { process.kill(pid) } catch { /* already gone */ }
    for (let i = 0; i < 20 && pidAlive(pid); i++) await sleep(250)
    writeFileSync(p.log, `===== ${new Date().toISOString()} stop ${p.name} pid=${pid} =====\n`, { flag: 'a' })
    console.log(`✔ ${p.name} 已停止 pid=${pid}`)
  }
  rmSync(p.pidFile, { force: true })
  const gw = readPid(p.gatewayPidFile)
  if (gw) {
    try { process.kill(gw) } catch { /* gone */ }
    console.log(`✔ 假网关已停止 pid=${gw}`)
  }
  rmSync(p.gatewayPidFile, { force: true })
}

async function status(names: string[]): Promise<void> {
  for (const name of names) {
    const p = loadProfile(name)
    const h = await health(p)
    const pid = readPid(p.pidFile) ?? (h ? pidOnPort(p.port) : null)
    if (!h) {
      console.log(`● ${name}  未运行（端口 ${p.port}）`)
      continue
    }
    console.log(`● ${name}  运行中 pid=${pid ?? '?'}  已运行 ${formatSec(Number(h.uptimeSec))}  在途 ${h.inflight}  签名 ${h.signature}`)
    console.log(`    上报 http://${p.host}:${p.port}${p.path}   网关 ${h.adapter}`)
    if (p.consolePort) console.log(`    后台 http://127.0.0.1:${p.consolePort}`)
    // Only errors since the current run started (its banner line).
    const recent = tail(p.log, 2000)
    const since = recent.findLastIndex((l) => l.startsWith('OneBot 上报监听'))
    const errors = recent.slice(since + 1).filter((l) => l.includes('"level":"error"')).slice(-3)
    for (const line of errors) console.log(`    最近错误 ${shortLine(line)}`)
  }
}

function formatSec(s: number): string {
  if (!Number.isFinite(s)) return '?'
  if (s < 120) return `${s}s`
  if (s < 7200) return `${Math.round(s / 60)}min`
  return `${(s / 3600).toFixed(1)}h`
}

function readFrom(file: string, byteOffset: number): string {
  if (!existsSync(file)) return ''
  return readFileSync(file).subarray(byteOffset).toString('utf8')
}

function tail(file: string, n: number): string[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-n)
}

/** One log line for humans: JSON lines become "time level kind status reason". */
function shortLine(line: string): string {
  if (!line.startsWith('{')) return line
  try {
    const o = JSON.parse(line) as Record<string, unknown>
    const time = typeof o.t === 'string' ? new Date(o.t).toLocaleTimeString('zh-CN', { hour12: false }) : ''
    const rest = Object.entries(o).filter(([k, v]) => !['t', 'level'].includes(k) && v !== null).map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    return `${time} ${o.level === 'error' ? 'ERROR ' : ''}${rest.join(' ')}`
  } catch {
    return line
  }
}

async function logs(p: Profile, opts: { n: number; follow: boolean; errors: boolean; heartbeat: boolean }): Promise<void> {
  const keep = (l: string): boolean =>
    (!opts.errors || l.includes('"level":"error"') || l.includes('Error')) && (opts.heartbeat || !l.includes('meta_event/'))
  for (const line of tail(p.log, opts.n * 4).filter(keep).slice(-opts.n)) console.log(shortLine(line))
  if (!opts.follow) return
  let size = existsSync(p.log) ? statSync(p.log).size : 0
  for (;;) {
    await sleep(500)
    if (!existsSync(p.log)) continue
    const now = statSync(p.log).size
    if (now < size) size = 0
    if (now === size) continue
    const fd = openSync(p.log, 'r')
    const buf = Buffer.alloc(now - size)
    const { readSync } = await import('node:fs')
    readSync(fd, buf, 0, buf.length, size)
    closeSync(fd)
    size = now
    for (const line of buf.toString('utf8').split(/\r?\n/).filter(Boolean).filter(keep)) console.log(shortLine(line))
  }
}

async function openConsole(p: Profile): Promise<void> {
  if (!p.consolePort || !p.ctl.CTL_CONSOLE_TOKEN_FILE) fail(`${p.name} 没有配置后台（CTL_CONSOLE_TOKEN_FILE）`)
  const token = readFileSync(abs(p.ctl.CTL_CONSOLE_TOKEN_FILE), 'utf8').trim()
  execFileSync('clip', { input: token })
  const url = `http://127.0.0.1:${p.consolePort}/`
  spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
  console.log(`已打开 ${url}，令牌已复制到剪贴板，粘贴到页面右上角即可`)
}

/** Post signed fake private messages and print what the bot sent to the fake gateway. */
async function say(p: Profile, texts: string[], opts: { user: string; real: boolean }): Promise<void> {
  if (!texts.length) fail('用法：scripts\\cl.cmd say <配置档> 第一条 [第二条 …]')
  if (!p.ctl.CTL_FAKE_GATEWAY && !opts.real) {
    fail(`${p.name} 连的是真网关：模拟消息会写进真数据库并尝试发到 QQ。确实要这样做请加 --real`)
  }
  if (!(await health(p))) fail(`${p.name} 没在运行，先 scripts\\cl.cmd start ${p.name}`)
  const env = resolveEnv(p)
  const secret = env.ONEBOT_SECRET
  const selfId = Number(env.ONEBOT_SELF_ID ?? 10001)
  const gwStart = existsSync(p.gatewayLog) ? statSync(p.gatewayLog).size : 0
  const logStart = existsSync(p.log) ? statSync(p.log).size : 0
  for (const [i, text] of texts.entries()) {
    if (i > 0) await sleep(1000)
    const event = {
      time: Math.floor(Date.now() / 1000), self_id: selfId, post_type: 'message', message_type: 'private', sub_type: 'friend',
      message_id: Date.now() % 2_000_000_000, user_id: Number(opts.user),
      message: [{ type: 'text', data: { text } }], raw_message: text, sender: { user_id: Number(opts.user), nickname: '调试' },
    }
    const body = JSON.stringify(event)
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (secret) headers['x-signature'] = `sha1=${createHmac('sha1', secret).update(body).digest('hex')}`
    const res = await fetch(`http://${p.host}:${p.port}${p.path}`, { method: 'POST', headers, body })
    console.log(`→ ${text}${res.status === 204 ? '' : `  （HTTP ${res.status}）`}`)
  }
  // Replies: new send_* lines on the fake gateway; done once the turn is logged and output is quiet.
  const started = Date.now()
  let printed = 0
  let quietSince = Date.now()
  while (Date.now() - started < 90_000) {
    await sleep(300)
    if (p.ctl.CTL_FAKE_GATEWAY && existsSync(p.gatewayLog)) {
      const sends = readFrom(p.gatewayLog, gwStart).split(/\r?\n/).filter((l) => /send_(private|group)_msg/.test(l))
      for (const line of sends.slice(printed)) {
        const m = line.match(/body=(\{.*\})$/)
        const msg = m ? (JSON.parse(m[1]!) as { message?: string }).message : line
        console.log(`← ${msg}`)
        quietSince = Date.now()
      }
      printed = Math.max(printed, sends.length)
    }
    const turnLines = readFrom(p.log, logStart).split(/\r?\n/).filter((l) => l.includes('"kind":"message/'))
    if (turnLines.length && Date.now() - quietSince > 1500) {
      for (const l of turnLines) console.log(`  ${shortLine(l)}`)
      if (p.consolePort) console.log(`  思维链：http://127.0.0.1:${p.consolePort}/#traces`)
      return
    }
  }
  console.log('90 秒内没有等到回复，看日志：scripts\\cl.cmd logs ' + p.name)
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2)
  const flags = new Set(rest.filter((a) => a.startsWith('-')))
  const valueOf = (flag: string, fallback: string): string => {
    const i = rest.indexOf(flag)
    return i >= 0 && rest[i + 1] ? rest[i + 1]! : fallback
  }
  const positional = rest.filter((a, i) => !a.startsWith('-') && !['-n', '--user'].includes(rest[i - 1] ?? ''))
  const name = positional[0]
  switch (cmd) {
    case 'start': return start(loadProfile(name), { inspect: flags.has('--inspect') })
    case 'stop': return stop(loadProfile(name))
    case 'restart': {
      const p = loadProfile(name)
      await stop(p, true)
      return start(p, { inspect: flags.has('--inspect') })
    }
    case 'status': return status(name ? [name] : listProfiles())
    case 'logs': return logs(loadProfile(name), {
      n: Number(valueOf('-n', '40')), follow: flags.has('-f'), errors: flags.has('--errors'), heartbeat: flags.has('--heartbeat'),
    })
    case 'console': return openConsole(loadProfile(name))
    case 'say': return say(loadProfile(name), positional.slice(1), { user: valueOf('--user', '20002'), real: flags.has('--real') })
    case 'profiles': {
      for (const n of listProfiles()) console.log(n)
      return
    }
    default:
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0]!.replace(/^\/\*\*\n?/, '').replace(/^ \* ?/gm, ''))
  }
}

await main()
