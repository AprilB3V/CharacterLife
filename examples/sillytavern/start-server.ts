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
 *   CHARACTERLIFE_CHARACTER_PACK 可选；角色包目录（docs/CHARACTER_PACK.md），不填用内置测试角色沈知微
 *
 * 运行：
 *   $env:CHARACTERLIFE_API_TOKEN = "local-dev-token-123"
 *   node examples/sillytavern/start-server.ts
 */

import { loadEnvConfig, assembleRuntime } from '../../src/api/runtime-factory.ts'
import { createApiServer } from '../../src/api/server.ts'
import { bootTelegram } from '../telegram/boot.ts'
import { bootConsole } from '../console-boot.ts'
import { describeTemplateMismatch, loadCharacterFromEnv } from '../character-module.ts'

const env = loadEnvConfig()
if (!env.token) {
  console.error('❌ 缺少 CHARACTERLIFE_API_TOKEN（至少 8 位）')
  console.error('   PowerShell: $env:CHARACTERLIFE_API_TOKEN = "local-dev-token-123"')
  process.exit(2)
}

const character = await loadCharacterFromEnv()
const modelId = character.modelId ?? 'characterlife/shen-zhiwei'
const runtime = assembleRuntime({
  dbPath: env.dbPath,
  ...(character.template ? { template: character.template } : {}),
  worldId: process.env.CHARACTERLIFE_WORLD ?? 'world_local',
  auditFile: null,
  ...(env.telegram
    ? {
        telegram: {
          token: env.telegram.token,
          apiBase: env.telegram.apiBase,
          proactive: env.telegram.proactive,
          parse: env.telegram.parse,
          splitParagraphs: env.telegram.splitParagraphs,
        },
      }
    : {}),
})

const mismatch = describeTemplateMismatch(runtime.persistence, runtime.template, env.dbPath)
if (mismatch) {
  console.error(`❌ ${mismatch}`)
  runtime.close()
  process.exit(2)
}

const api = createApiServer({
  runtime,
  token: env.token,
  host: env.host,
  port: env.port,
  stIdentityUserId: env.stIdentity,
  modelId,
  allowNonLoopback: process.env.CHARACTERLIFE_ALLOW_PUBLIC === 'true',
})

const { url } = await api.listen()
console.log(`CharacterLife API 已启动：${url}`)
console.log(`数据库：${env.dbPath}`)
if (character.label) console.log(`角色：${character.label}`)
console.log('')
console.log('SillyTavern 配置（Chat Completion → Custom (OpenAI-compatible)）：')
console.log(`  Base URL : ${url}/v1`)
console.log('  API Key  : 使用已配置的 CHARACTERLIFE_API_TOKEN（不在日志中显示）')
console.log(`  模型      : 从下拉列表里选 ${modelId}`)
console.log('')
console.log('健康检查： GET /healthz    模型列表： GET /v1/models（需要 Bearer Token）')

const telegram = env.telegram ? await bootTelegram(runtime, env.telegram) : null
const ownerConsole = await bootConsole(runtime)

process.on('SIGINT', () => {
  void Promise.allSettled([api.close(), telegram?.stop(), ownerConsole?.close()]).finally(() => {
    runtime.close()
    process.exit(0)
  })
})
