/**
 * 受控复现：在同一个会话里先问「书」，再问「约定」，观察第二次是否返回空 reply。
 *
 * 目的：实验里 14 次调用中有 5 次记录为空（completion tokens 却不为 0）。
 * 本脚本只发 2 次请求，并在收到响应时打印原始长度与正文，判断空回复到底来自
 * 「模型返回空 content」还是「harness 记账错位」。
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

let n = 0
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
    n++
    const res = await this.#inner.complete(request)
    console.log(`\n[调用 ${n}] text.length=${res.text.length} finish=${res.finishReason} reasoning=${res.reasoningChars} usage=${JSON.stringify(res.usage)}`)
    console.log(`  raw: ${JSON.stringify(res.text.slice(0, 600))}`)
    console.log(`  messages=${request.messages.length} systemChars=${request.system.length}`)
    return res
  }
}

const db = new CharacterDatabase(dbFile)
const persistence = new CharacterPersistence(db)
const session = PersistentSession.open({
  persistence,
  instanceId: INSTANCE_ID,
  provider: new RawCapture(new DeepSeekProvider({ apiKey, baseUrl, model })),
  clock: new ManualClock(0),
  ids: new SequentialIdFactory(),
  rng: new SeededRng(1),
  budget: { maxPromptTokens: 4000 },
  probeQuery: '那本书',
})

for (const text of ['你还记得我说的那本书吗？它是什么情况？', '我们之前说好的事还记得吗？']) {
  const r = await session.send(text)
  console.log(`结果 reply(${r.reply.length}) = ${JSON.stringify(r.reply)} provider=${r.provider}`)
}
session.close('user_exit')
db.close()
