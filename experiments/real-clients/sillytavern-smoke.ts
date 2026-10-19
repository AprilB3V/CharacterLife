/**
 * 真实 SillyTavern 客户端联调探针（服务端转发路径）。
 *
 * 这一步不是「原始 HTTP 测试」：它启动本机的 SillyTavern 1.17.0，
 * 通过酒馆自己的 `/api/backends/chat-completions/generate` 路由，
 * 让**酒馆的服务端代码**构造请求并调用 CharacterLife 的 OpenAI 兼容接口。
 *
 * 局限（必须明确）：这不是浏览器 UI 级联调（本环境没有可用浏览器），
 * 酒馆前端的流式解析、角色卡渲染等仍未覆盖。
 *
 * 运行：
 *   node experiments/real-clients/sillytavern-smoke.ts
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assembleRuntime } from '../../src/api/runtime-factory.ts'
import { createApiServer } from '../../src/api/server.ts'
import { MockProvider } from '../../src/conversation/providers/mock.ts'
import { ManualClock } from '../../src/util/clock.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const ST_DIR = process.env.SILLYTAVERN_DIR ?? 'C:\\Git\\SillyTavern-1.17.0'
const ST_PORT = 8799
const CL_PORT = 8798
const TOKEN = 'st-probe-token-123'

const print = (t = ''): void => console.log(t)

async function waitFor(url: string, timeoutMs: number): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return true
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return false
}

async function main(): Promise<void> {
  if (!existsSync(ST_DIR)) {
    print(`❌ 找不到 SillyTavern 目录：${ST_DIR}（可用 SILLYTAVERN_DIR 指定）`)
    process.exit(2)
  }

  const dataRoot = join(root, '.st-data')
  mkdirSync(dataRoot, { recursive: true })

  // 1) 起 CharacterLife API
  const runtime = assembleRuntime({
    dbPath: join(dataRoot, 'st-probe.db'),
    worldId: 'world_st_probe',
    provider: new MockProvider({ mode: 'in-character' }),
    clock: new ManualClock(0),
  })
  const api = createApiServer({
    runtime,
    token: TOKEN,
    port: CL_PORT,
    logger: () => {},
    stIdentityUserId: 'local-default',
  })
  await api.listen()
  print(`CharacterLife API：http://127.0.0.1:${CL_PORT}`)

  // 2) 起 SillyTavern（dataRoot 放在工作区内，避免写用户目录）
  //    --disableCsrf 只用于本机探针：酒馆的 CSRF token 绑定浏览器会话 cookie，
  //    无浏览器的脚本无法自动完成校验。生产/日常使用请保持 CSRF 开启。
  const stProc = spawn(
    process.execPath,
    ['server.js', '--dataRoot', dataRoot, '--port', String(ST_PORT), '--disableCsrf'],
    { cwd: ST_DIR, stdio: 'ignore', windowsHide: true },
  )
  print(`启动 SillyTavern（pid=${stProc.pid}）… 首次启动要编译前端，约 30-60 秒`)

  const ready = await waitFor(`http://127.0.0.1:${ST_PORT}/version`, 120_000)
  if (!ready) {
    print('❌ SillyTavern 未在 120 秒内就绪')
    stProc.kill()
    await api.close()
    runtime.close()
    process.exit(1)
  }
  const version = (await (await fetch(`http://127.0.0.1:${ST_PORT}/version`)).json()) as {
    pkgVersion?: string
    agent?: string
  }
  print(`✅ SillyTavern 就绪：pkgVersion=${version.pkgVersion ?? '?'}`)

  // 3) CSRF（酒馆对 POST 有校验）
  let csrfToken = ''
  let cookie = ''
  try {
    const csrfRes = await fetch(`http://127.0.0.1:${ST_PORT}/csrf-token`)
    csrfToken = ((await csrfRes.json()) as { token: string }).token
    cookie = (csrfRes.headers.get('set-cookie') ?? '').split(';')[0] ?? ''
  } catch (err) {
    print(`⚠️ 取 CSRF 失败：${(err as Error).message}`)
  }

  // 4) 通过酒馆自己的 generate 路由调用 CharacterLife
  const body = {
    chat_completion_source: 'custom',
    custom_url: `http://127.0.0.1:${CL_PORT}/v1`,
    custom_model: 'characterlife/shen-zhiwei',
    custom_include_headers: `Authorization: Bearer ${TOKEN}`,
    model: 'characterlife/shen-zhiwei',
    messages: [
      { role: 'system', content: '你是沈知微，旧书修复师，温和但有边界。' },
      { role: 'user', content: '你好，我家里有一本被水泡过的《陶庵梦忆》，还有救吗？' },
    ],
    max_tokens: 300,
    temperature: 0.7,
    stream: false,
  }

  print('')
  print('通过酒馆 /api/backends/chat-completions/generate 转发请求…')
  try {
    const res = await fetch(`http://127.0.0.1:${ST_PORT}/api/backends/chat-completions/generate`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
        ...(cookie ? { cookie } : {}),
      },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    print(`  HTTP ${res.status}`)
    print(`  响应（截断 600 字）：${text.slice(0, 600)}`)
    if (res.ok && text.includes('choices')) {
      print('')
      print('✅ 酒馆服务端 → CharacterLife 转发成功（这是真实酒馆代码路径，不是裸 HTTP 测试）')
    } else {
      print('')
      print('⚠️ 酒馆返回了非预期结果，详见上面响应；这本身也是有效记录（说明还没打通）')
    }
  } catch (err) {
    print(`❌ 请求酒馆失败：${(err as Error).message}`)
  }

  stProc.kill()
  await api.close()
  runtime.close()
  print('')
  print('已停止酒馆与 API。dataRoot：' + dataRoot)
}

await main()
