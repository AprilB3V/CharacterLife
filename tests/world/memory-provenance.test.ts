/**
 * P0 · 记忆来源隔离（模型自述 ≠ 世界事实）
 *
 * 实机联调暴露的问题：模型把「桌上有一本翻开的旧书、一块镇纸、一支铅笔」写进
 * `memoryWrites`（status=fact），下一轮又被当作「事实」检索回来，越说越具体。
 *
 * 修法不是关键词过滤，而是复用已有的来源 / 认识论轴：
 *   character_message（模型自述） → 认识论上限 speculation
 *   user_message（用户自述）      → 可以是 fact
 *   runtime_event（运行时/世界回执）→ 可以是 fact
 *
 * 判据落在 `PolicyEngine.evaluateMemoryWrite`，也就是所有记忆写入的唯一收口。
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/types.ts'
import { CONVERSATION_ACTOR, RUNTIME_ACTOR } from '../../src/policy/policy.ts'
import { renderMemoryData } from '../../src/conversation/context.ts'
import { cleanupRigs, createRig } from '../helpers.ts'
import { ConversationService } from '../../src/conversation/service.ts'
import { WorldService } from '../../src/world/service.ts'
import { SequentialIdFactory } from '../../src/util/ids.ts'

after(() => cleanupRigs())

/** 固定返回一份信封的 Provider，用来精确控制「模型写了什么记忆」。 */
class StoryProvider implements LLMProvider {
  readonly name = 'story'
  readonly model = 'story-1'
  #payload: Record<string, unknown>
  constructor(payload: Record<string, unknown>) {
    this.#payload = payload
  }
  async complete(_request: LLMRequest): Promise<LLMResponse> {
    return {
      text: JSON.stringify(this.#payload),
      provider: this.name,
      model: this.model,
      usage: null,
      latencyMs: 0,
      finishReason: 'stop',
    }
  }
}

/** 联调里实际出现的那句话。 */
const FABRICATED = '桌上有一本翻开的旧书、一块镇纸、一支铅笔，书页没有新的折痕'

function writeWith(
  rig: ReturnType<typeof createRig>,
  origin: 'character_message' | 'user_message' | 'runtime_event',
  status: 'fact' | 'speculation' | 'fiction' = 'fact',
) {
  return rig.workspace.writeMemory(
    {
      kind: 'episodic',
      title: '桌上的东西',
      content: FABRICATED,
      status,
      origin,
      salience: 0.8,
      tags: [],
    },
    origin === 'character_message' ? CONVERSATION_ACTOR : RUNTIME_ACTOR,
    `test:${origin}`,
  )
}

describe('P0 · 来源决定认识论上限', () => {
  it('模型自述永远是「推测」：写 fact 也落成 speculation', () => {
    const rig = createRig()
    const outcome = writeWith(rig, 'character_message', 'fact')

    assert.equal(outcome.written, true)
    assert.equal(outcome.verdict, 'MODEL_CLAIM_DOWNGRADED')

    const entry = rig.workspace.memory.get(outcome.entryId!)!
    assert.equal(entry.status, 'speculation')
    assert.equal(entry.origin, 'character_message')
    assert.equal(entry.trust, 'trusted', '不是注入，不需要打 untrusted')
  })

  it('同一句话：用户自述与运行时回执可以是事实', () => {
    const rig = createRig()

    const user = writeWith(rig, 'user_message', 'fact')
    assert.equal(user.verdict, 'ALLOWED')
    assert.equal(rig.workspace.memory.get(user.entryId!)!.status, 'fact')

    const runtime = writeWith(rig, 'runtime_event', 'fact')
    assert.equal(runtime.verdict, 'ALLOWED')
    assert.equal(rig.workspace.memory.get(runtime.entryId!)!.status, 'fact')
  })

  it('模型写 fiction / speculation 不受影响（本来就低于事实）', () => {
    const rig = createRig()
    for (const status of ['fiction', 'speculation'] as const) {
      const outcome = writeWith(rig, 'character_message', status)
      assert.equal(outcome.verdict, 'ALLOWED')
      assert.equal(rig.workspace.memory.get(outcome.entryId!)!.status, status)
    }
  })

  it('降级会写审计，且不吞掉写入', () => {
    const rig = createRig()
    const outcome = writeWith(rig, 'character_message', 'fact')
    assert.equal(outcome.written, true)

    const audit = rig.workspace.audit.filter('injection_detected')
    assert.ok(audit.some((e) => e.data.code === 'MODEL_CLAIM_DOWNGRADED'))

    const written = rig.workspace.audit.filter('memory_written')
    assert.equal(written.at(-1)!.data.verdictCode, 'MODEL_CLAIM_DOWNGRADED')
  })

  it('模型用 tags 打「world」也改变不了来源与状态（与 F4 联动）', () => {
    const rig = createRig()
    rig.workspace.writeMemory(
      {
        kind: 'episodic',
        title: '使用书桌',
        content: FABRICATED,
        status: 'fact',
        origin: 'character_message',
        salience: 0.9,
        tags: ['world', 'desk'],
      },
      CONVERSATION_ACTOR,
      'turn_x',
    )
    const entry = rig.workspace.memory.list().at(-1)!
    assert.equal(entry.origin, 'character_message')
    assert.equal(entry.status, 'speculation')
    assert.deepEqual(entry.tags.filter((t) => t === 'world'), [])
  })
})

describe('P0 · 检索与上下文表现', () => {
  it('进入上下文时标注为「推测」，不会被当成事实', () => {
    const rig = createRig()
    writeWith(rig, 'character_message', 'fact')
    const rendered = renderMemoryData(rig.workspace.memory.list(), 0)
    assert.match(rendered, /推测/)
    assert.ok(!rendered.includes('｜事实｜'))
  })

  it('正常对话记忆仍然可检索（降级不等于删除）', () => {
    const rig = createRig()
    writeWith(rig, 'character_message', 'fact')
    const hits = rig.workspace.memory.search('桌上的东西', { nowSim: 0, limit: 5, budgetChars: 900 })
    assert.equal(hits.length, 1)
    assert.equal(hits[0]!.entry.status, 'speculation')
  })
})

describe('P0 · 不破坏既有记忆功能', () => {
  it('用户偏好记忆（kind=user）仍按 user_message 写入并可检索', async () => {
    const rig = createRig()
    const provider = new StoryProvider({
      reply: '记住了。',
      proposals: [],
      memoryWrites: [
        { kind: 'user', title: '喜欢的颜色', content: '用户喜欢深蓝色', status: 'fact', salience: 0.8 },
      ],
      worldActions: [],
    })
    const service = new ConversationService({
      workspace: rig.workspace,
      provider,
      clock: rig.clock,
      ids: new SequentialIdFactory(),
    })
    await service.send('我喜欢深蓝色，你记一下。')

    const prefs = rig.workspace.memory.list({ kinds: ['user'] })
    assert.equal(prefs.length, 1)
    assert.equal(prefs[0]!.origin, 'user_message')
    assert.equal(prefs[0]!.status, 'fact', '用户偏好不受模型自述降级影响')
    assert.equal(prefs[0]!.confirmed, false, '但仍是「未经用户确认」')

    const hits = rig.workspace.memory.search('深蓝色', { nowSim: 0, limit: 5, budgetChars: 900 })
    assert.equal(hits.length, 1)
  })

  it('普通聊天记忆仍会写入（只是标为推测）', async () => {
    const rig = createRig()
    const provider = new StoryProvider({
      reply: '嗯。',
      proposals: [],
      memoryWrites: [
        { kind: 'episodic', title: '一次对话', content: '用户说今天加班到很晚', status: 'fact', salience: 0.5 },
      ],
      worldActions: [],
    })
    const service = new ConversationService({
      workspace: rig.workspace,
      provider,
      clock: rig.clock,
      ids: new SequentialIdFactory(),
    })
    await service.send('今天加班到很晚。')

    const memories = rig.workspace.memory.list({ kinds: ['episodic'] })
    assert.equal(memories.length, 1)
    assert.equal(memories[0]!.origin, 'character_message')
    assert.equal(memories[0]!.status, 'speculation')
    assert.match(memories[0]!.content, /加班/)
  })
})

describe('P0 · 世界事实只来自回执（端到端）', () => {
  it('模型编造桌面细节后，权威世界上下文仍然为空', async () => {
    const rig = createRig()
    const provider = new StoryProvider({
      reply: '我到桌边看过了，桌上有一本翻开的旧书、一块镇纸、一支铅笔。',
      proposals: [],
      memoryWrites: [
        { kind: 'episodic', title: '桌上的东西', content: FABRICATED, status: 'fact', salience: 0.9 },
      ],
      // 没有世界回执，模型自己声称"看过了"
      worldActions: [],
    })
    const ids = new SequentialIdFactory()
    const world = new WorldService({
      clock: rig.clock,
      ids,
      lookupInstance: (id) => (id === 'inst_001' ? { worldId: 'cl-world-test' } : null),
      worldIds: ['cl-world-test'],
      allowedVerbs: ['use'],
      allowedTargets: ['desk_01'],
    })
    const service = new ConversationService({
      workspace: rig.workspace,
      provider,
      clock: rig.clock,
      ids,
      world: { service: world, instanceId: 'inst_001', worldId: 'cl-world-test' },
    })
    const result = await service.send('桌边怎么样？')

    // 1) 记忆写入但被降级
    const entry = rig.workspace.memory.list().find((m) => m.content.includes('旧书'))!
    assert.equal(entry.status, 'speculation')
    assert.equal(entry.origin, 'character_message')

    // 2) 世界上下文没有任何"已确认"结果（没有回执就没有事实）
    assert.deepEqual(result.worldContext?.confirmed, [])
    assert.deepEqual(result.worldContext?.unconfirmed, [])

    // 3) 下一轮的数据区把它标成推测
    assert.match(renderMemoryData(rig.workspace.memory.list(), 0), /推测/)
  })
})
