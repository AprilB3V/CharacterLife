/**
 * 诊断：为什么有些真实模型回复是空的？
 *
 * 现象：completion tokens 不为 0（23～163），但 `reply` 为空串。
 * 可能原因：
 *   1. `content` 为空、正文在 `reasoning_content` 里（思考型模型）；
 *   2. `finish_reason = length`，内容被截断成空；
 *   3. 模型返回了 JSON 但 `reply` 字段为空。
 *
 * 本脚本复用实验数据库，只发 1 次请求，把原始响应字段打出来。
 * 运行：
 *   $env:DEEPSEEK_API_KEY = [Environment]::GetEnvironmentVariable('DEEPSEEK_API_KEY','User')
 *   node experiments/real-model/diagnose-empty.ts
 */

import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/types.ts'
import { DeepSeekProvider, deepSeekConfigFromEnv } from '../../src/conversation/providers/deepseek.ts'
import { CharacterDatabase } from '../../src/persistence/database.ts'
import { CharacterPersistence } from '../../src/persistence/store.ts'
import { PersistentSession } from '../../src/character/persistent-session.ts'
import { ManualClock } from '../../src/util/clock.ts'
import { SeededRng } from '../../src/util/rng.ts'
import { SequentialIdFactory } from '../../src/util/ids.ts'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const dbFile = join(here, '.data', 'real-continuity.db')
const INSTANCE_ID = 'inst_real_player'

const cfg = deepSeekConfigFromEnv()
if (!cfg) {
  console.error('❌ 没有 DEEPSEEK_API_KEY')
  process.exit(2)
}
const { apiKey, baseUrl, model } = cfg

class RawCapture implements LLMProvider {
  #inner: LLMProvider
  constructor(inner: LLMProvider) {
    this.#inner = inner
  }
  get name(): string {
    return this.#inner.name
  }
  get model(): string {
    return this.#inner.model
  }
  async complete(request: LLMRequest): Promise<LLMResponse> {
    const res = await this.#inner.complete(request)
    console.log('--- 原始响应诊断 ---')
    console.log(`text.length = ${res.text.length}`)
    console.log(`finish_reason = ${res.finishReason}`)
    console.log(`reasoning_content 长度 = ${res.reasoningChars}`)
    console.log(`usage = ${JSON.stringify(res.usage)}`)
    console.log(`前 500 字：${JSON.stringify(res.text.slice(0, 500))}`)
    console.log(`system 长度 = ${request.system.length}，messages = ${request.messages.length}`)
    console.log(`最后一条 user 长度 = ${request.messages[request.messages.length - 1]?.content.length}`)
    return res
  }
}

const db = new CharacterDatabase(dbFile)
const persistence = new CharacterPersistence(db)
const clock = new ManualClock(0)
const session = PersistentSession.open({
  persistence,
  instanceId: INSTANCE_ID,
  provider: new RawCapture(new DeepSeekProvider({ apiKey, baseUrl, model })),
  clock,
  ids: new SequentialIdFactory(),
  rng: new SeededRng(1),
  budget: { maxPromptTokens: 4000 },
  probeQuery: '那本书',
})

const result = await session.send('我们之前说好的事还记得吗？')
console.log('--- 解析后的结果 ---')
console.log(`reply = ${JSON.stringify(result.reply)}`)
console.log(`provider = ${result.provider}，degradation = ${result.contextUsage?.degradation}`)
session.close('user_exit')
db.close()
