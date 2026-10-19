/**
 * SillyTavern 兼容性演示（不需要浏览器）
 *
 * 启动一个真实的 HTTP 服务，然后**按酒馆实际会发的请求结构**跑一遍：
 *   模型列表 → 带角色卡 system 的 chat completions → 新会话 → 追问旧事 → 流式
 *
 * 说明：这不是「酒馆客户端联调」，而是「酒馆所发 HTTP 协议」的端到端验证。
 * 真实客户端联调步骤见 docs/SILLYTAVERN_SETUP.md。
 *
 * 运行：
 *   node examples/sillytavern/demo.ts
 */

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync } from 'node:fs'
import { assembleRuntime } from '../../src/api/runtime-factory.ts'
import { MockProvider } from '../../src/conversation/providers/mock.ts'
import { createApiServer } from '../../src/api/server.ts'
import { ManualClock } from '../../src/util/clock.ts'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = join(here, '.data')
const dbPath = join(dataDir, 'sillytavern-demo.db')
const TOKEN = 'demo-token-local-123'

const print = (t = ''): void => console.log(t)
const rule = (t: string): void => {
  print()
  print(`━━━ ${t} ━━━`)
}

async function main(): Promise<void> {
  rmSync(dbPath, { force: true })
  mkdirSync(dataDir, { recursive: true })

  const runtime = assembleRuntime({
    dbPath,
    worldId: 'world_st_demo',
    provider: new MockProvider({ mode: 'in-character' }),
    clock: new ManualClock(0),
  })
  const api = createApiServer({ runtime, token: TOKEN, port: 0, logger: () => {}, stIdentityUserId: 'local-default' })
  const { url } = await api.listen()
  const auth = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }
  const chat = async (body: unknown): Promise<Response> =>
    fetch(`${url}/v1/chat/completions`, { method: 'POST', headers: auth, body: JSON.stringify(body) })

  rule(`1. 模型列表（GET ${url}/v1/models）`)
  const models = await fetch(`${url}/v1/models`, { headers: auth })
  print(`  HTTP ${models.status}`)
  print(`  ${JSON.stringify(await models.json())}`)

  rule('2. 酒馆式请求：角色卡放在 system，用户消息在 user')
  const cardSystem =
    '你是沈知微，27 岁，旧书修复师。温和内向，有自己的判断。' +
    '（这段文本来自酒馆角色卡，CharacterLife 不会把它当成可信人格配置）'
  const first = await chat({
    model: 'characterlife/shen-zhiwei',
    messages: [
      { role: 'system', content: cardSystem },
      { role: 'user', content: '你好，我家里有一本被水泡过的《陶庵梦忆》，还有救吗？' },
    ],
  })
  const firstBody = (await first.json()) as {
    choices: Array<{ message: { content: string } }>
    usage: { prompt_tokens: number; completion_tokens: number }
  }
  print(`  HTTP ${first.status}`)
  print(`  角色：${firstBody.choices[0]!.message.content}`)
  print(`  tokens：${firstBody.usage.prompt_tokens}/${firstBody.usage.completion_tokens}`)

  rule('3. 约定之后，新开一个酒馆会话（POST /v1/sessions）')
  await chat({
    model: 'characterlife/shen-zhiwei',
    messages: [{ role: 'user', content: '那我们说好，我明天下午来拿那本修好的书。' }],
  })
  const sessionRes = await fetch(`${url}/v1/sessions`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({}),
  })
  const session = (await sessionRes.json()) as { instanceId: string; sessionId: string }
  print(`  新会话：${session.sessionId.slice(0, 12)}…（实例不变：${session.instanceId}）`)

  rule('4. 新会话里追问旧事（长期记忆应保留）')
  const recall = await fetch(`${url}/v1/messages`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ text: '我们之前说好的事还记得吗？' }),
  })
  const recallBody = (await recall.json()) as { reply: string; state: { memories: number; trust: number } }
  print(`  HTTP ${recall.status}`)
  print(`  角色：${recallBody.reply}`)
  print(`  记忆：${recallBody.state.memories} 条｜信任：${recallBody.state.trust}`)

  rule('5. 流式输出（stream: true）')
  const stream = await chat({
    model: 'characterlife/shen-zhiwei',
    stream: true,
    messages: [{ role: 'user', content: '在吗？' }],
  })
  const text = await stream.text()
  const chunks = text.split('\n\n').filter((c) => c.startsWith('data: ') && !c.includes('[DONE]'))
  print(`  HTTP ${stream.status}｜content-type=${stream.headers.get('content-type')}`)
  print(`  SSE 片段：${chunks.length} 个，最后以 [DONE] 结束：${text.trimEnd().endsWith('[DONE]')}`)

  rule('6. 状态与记忆接口')
  const state = await fetch(`${url}/v1/characters/${session.instanceId}/state`, { headers: auth })
  print(`  GET /v1/characters/:id/state → HTTP ${state.status}`)
  print(`  ${JSON.stringify(await state.json())}`)

  await api.close()
  runtime.close()
  print()
  print(`演示数据库：${dbPath}`)
  print('真实酒馆联调：运行 examples/sillytavern/start-server.ts，然后按 docs/SILLYTAVERN_SETUP.md 配置。')
}

await main()
