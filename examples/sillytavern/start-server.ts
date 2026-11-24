/**
 * 启动 CharacterLife 的 OpenAI 兼容 API（SillyTavern 用这个地址）
 *
 * 环境变量：
 *   CHARACTERLIFE_API_TOKEN   必填，至少 8 位
 *   CHARACTERLIFE_DB          数据库路径（默认 data/characterlife.db）
 *   CHARACTERLIFE_PORT        端口（默认 8787）
 *   CHARACTERLIFE_HOST        默认 127.0.0.1（只监听本机）
 *   CHARACTERLIFE_ST_IDENTITY SillyTavern 本地身份（默认 local-default）
 *   DEEPSEEK_API_KEY          可选；没有则用 MockProvider
 *   TELEGRAM_BOT_TOKEN        可选；设置后在同一进程里启动 Telegram 机器人（见 .env.example）
 *   CHARACTERLIFE_CHARACTERS_DIR 角色库目录（默认 ./characters）：里面每个角色包都是 ST 下拉框里的一个模型，
 *                             各用一个数据库（与 CHARACTERLIFE_DB 同目录的 <id>.db；沈知微沿用 CHARACTERLIFE_DB）
 *   CHARACTERLIFE_DEFAULT_CHARACTER 可选；默认角色的包 id（不填时示例角色鲸鲸，其次沈知微，再其次第一个）
 *   CHARACTERLIFE_CHARACTER_PACK 可选；只跑这一个角色包（docs/CHARACTER_PACK.md），用 CHARACTERLIFE_DB
 *   CHARACTERLIFE_AUTO_MIGRATE  默认开；设为 false 时，改过版本的角色不自动迁移旧对话
 *
 * 运行：
 *   $env:CHARACTERLIFE_API_TOKEN = "local-dev-token-123"
 *   node examples/sillytavern/start-server.ts
 */

import { loadEnvConfig, assembleRuntime } from '../../src/api/runtime-factory.ts'
import type { RuntimeBundle } from '../../src/api/runtime-factory.ts'
import { createApiServer } from '../../src/api/server.ts'
import { createCharacterRouter } from '../../src/api/character-router.ts'
import { bootTelegram } from '../telegram/boot.ts'
import { bootConsole } from '../console-boot.ts'
import { loadCharacterLibrary, prepareCharacterDatabase } from '../character-module.ts'

const env = loadEnvConfig()
if (!env.token) {
  console.error('❌ 缺少 CHARACTERLIFE_API_TOKEN（至少 8 位）')
  console.error('   PowerShell: $env:CHARACTERLIFE_API_TOKEN = "local-dev-token-123"')
  process.exit(2)
}

const library = await loadCharacterLibrary(env.dbPath)
for (const line of library.skipped) console.error(`⚠ 跳过角色包 ${line}`)

const worldId = process.env.CHARACTERLIFE_WORLD ?? 'world_local'
const telegramConfig = env.telegram
  ? {
      token: env.telegram.token,
      apiBase: env.telegram.apiBase,
      proactive: env.telegram.proactive,
      parse: env.telegram.parse,
      splitParagraphs: env.telegram.splitParagraphs,
    }
  : null

interface Running {
  modelId: string
  label: string
  dbPath: string
  runtime: RuntimeBundle
}
const running: Running[] = []
for (const [index, entry] of library.entries.entries()) {
  // Telegram follows the default character only; one bot token cannot serve several characters.
  const runtime = assembleRuntime({
    dbPath: entry.dbPath,
    template: entry.template,
    worldId,
    auditFile: null,
    ...(index === 0 && telegramConfig ? { telegram: telegramConfig } : {}),
  })
  const prepared = prepareCharacterDatabase(runtime, entry.dbPath)
  for (const u of prepared.upgrades) console.log(`角色已更新：${entry.label}（${u.instanceId} v${u.from} → v${u.to}，记忆保留）`)
  if (prepared.problem) {
    runtime.close()
    if (library.dir === null) {
      console.error(`❌ ${prepared.problem}`)
      process.exit(2)
    }
    console.error(`⚠ 跳过角色 ${entry.label}：${prepared.problem}`)
    continue
  }
  running.push({ modelId: entry.modelId, label: entry.label, dbPath: entry.dbPath, runtime })
}
if (running.length === 0) {
  console.error('❌ 没有能启动的角色')
  process.exit(2)
}

const listedModels = running.map((r) => ({ id: r.modelId, label: `CharacterLife · ${r.runtime.template.profile.name}` }))
const apis = running.map((r) => createApiServer({
  runtime: r.runtime,
  token: env.token!,
  host: env.host,
  port: env.port,
  stIdentityUserId: env.stIdentity,
  modelId: r.modelId,
  listedModels,
  allowNonLoopback: process.env.CHARACTERLIFE_ALLOW_PUBLIC === 'true',
}))
const router = createCharacterRouter({
  characters: running.map((r, i) => ({ modelId: r.modelId, label: r.label, api: apis[i]! })),
  host: env.host,
  port: env.port,
  allowNonLoopback: process.env.CHARACTERLIFE_ALLOW_PUBLIC === 'true',
})

const primary = running[0]!
const { url } = await router.listen()
console.log(`CharacterLife API 已启动：${url}`)
if (library.dir) console.log(`角色库：${library.dir}`)
for (const r of running) console.log(`  ${r.modelId.padEnd(32)} ${r.label}  →  ${r.dbPath}`)
console.log('')
console.log('SillyTavern 配置（Chat Completion → Custom (OpenAI-compatible)）：')
console.log(`  Base URL : ${url}/v1`)
console.log('  API Key  : 使用已配置的 CHARACTERLIFE_API_TOKEN（不在日志中显示）')
console.log(`  模型      : 从下拉列表里选角色（默认 ${primary.modelId}）`)
console.log('')
console.log('新建或修改角色： npm run studio（保存后重启本服务）')
console.log('健康检查： GET /healthz    模型列表： GET /v1/models（需要 Bearer Token）')

const telegram = env.telegram ? await bootTelegram(primary.runtime, env.telegram) : null
const ownerConsole = await bootConsole(primary.runtime)

process.on('SIGINT', () => {
  void Promise.allSettled([router.close(), telegram?.stop(), ownerConsole?.close()]).finally(() => {
    for (const r of running) r.runtime.close()
    process.exit(0)
  })
})
