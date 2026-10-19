/**
 * 真实模型冒烟测试（1 次调用）
 *
 * 目的：在跑任何正式实验前，先确认三件事：
 *   1. API 路由与密钥可用；
 *   2. 服务端返回的 `model` 到底是什么（不靠猜）；
 *   3. `response_format: json_object` 是否被接受。
 *
 * 运行（密钥只从环境变量读取，不会写入任何文件）：
 *   $env:DEEPSEEK_API_KEY = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY','User')
 *   node experiments/real-model/smoke.ts
 */

import { DeepSeekProvider, deepSeekConfigFromEnv } from '../../src/index.ts'

const cfg = deepSeekConfigFromEnv()
if (!cfg) {
  console.error('❌ 环境里没有 DEEPSEEK_API_KEY；未执行任何真实调用。')
  process.exit(2)
}

console.log(`路由：${cfg.baseUrl}/chat/completions`)
console.log(`请求模型：${cfg.model}`)

const provider = new DeepSeekProvider({ apiKey: cfg.apiKey, baseUrl: cfg.baseUrl, model: cfg.model })
try {
  const res = await provider.complete({
    system: '你是一个测试端点。只输出 JSON：{"reply":"..."}，reply 用一句中文确认收到。',
    messages: [{ role: 'user', content: '收到请回答' }],
    temperature: 0,
    maxTokens: 80,
    jsonMode: true,
  })
  console.log('--- 响应 ---')
  console.log(`实际模型：${res.model}`)
  console.log(`延迟：${res.latencyMs} ms`)
  console.log(`用量：prompt=${res.usage?.promptTokens} completion=${res.usage?.completionTokens}`)
  console.log(`正文：${res.text.slice(0, 200)}`)
  const parsed = JSON.parse(res.text) as { reply?: string }
  console.log(`JSON 契约：${typeof parsed.reply === 'string' ? '✅ 可解析且含 reply' : '❌ 缺少 reply'}`)
} catch (err) {
  console.error(`❌ 调用失败：${(err as Error).message}`)
  process.exit(1)
}
