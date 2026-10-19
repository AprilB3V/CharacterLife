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
 *
 * 运行：
 *   $env:CHARACTERLIFE_API_TOKEN = "local-dev-token-123"
 *   node examples/sillytavern/start-server.ts
 */

import { loadEnvConfig, assembleRuntime } from '../../src/api/runtime-factory.ts'
import { createApiServer } from '../../src/api/server.ts'

const env = loadEnvConfig()
if (!env.token) {
  console.error('❌ 缺少 CHARACTERLIFE_API_TOKEN（至少 8 位）')
  console.error('   PowerShell: $env:CHARACTERLIFE_API_TOKEN = "local-dev-token-123"')
  process.exit(2)
}

const runtime = assembleRuntime({
  dbPath: env.dbPath,
  worldId: process.env.CHARACTERLIFE_WORLD ?? 'world_local',
  auditFile: null,
})

const api = createApiServer({
  runtime,
  token: env.token,
  host: env.host,
  port: env.port,
  stIdentityUserId: env.stIdentity,
  allowNonLoopback: process.env.CHARACTERLIFE_ALLOW_PUBLIC === 'true',
})

const { url } = await api.listen()
console.log(`CharacterLife API 已启动：${url}`)
console.log(`数据库：${env.dbPath}`)
console.log('')
console.log('SillyTavern 配置（Chat Completion → Custom (OpenAI-compatible)）：')
console.log(`  Base URL : ${url}/v1`)
console.log('  API Key  : 使用已配置的 CHARACTERLIFE_API_TOKEN（不在日志中显示）')
console.log('  模型      : 从下拉列表里选 characterlife/shen-zhiwei')
console.log('')
console.log('健康检查： GET /healthz    模型列表： GET /v1/models（需要 Bearer Token）')

process.on('SIGINT', () => {
  void api.close().finally(() => {
    runtime.close()
    process.exit(0)
  })
})
