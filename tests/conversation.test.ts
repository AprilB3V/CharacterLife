/**
 * Conversation 模块测试：上下文组装、结构化输出、边界短路、模型失败降级。
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { LLMProvider, LLMRequest, LLMResponse } from '../src/types.ts'
import { cleanupRigs, createRig, SpyProvider } from './helpers.ts'
import { MockProvider } from '../src/conversation/providers/mock.ts'
import { RUNTIME_ACTOR } from '../src/policy/policy.ts'

after(() => cleanupRigs())

class ThrowingProvider implements LLMProvider {
  readonly name = 'throwing'
  readonly model = 'throwing-1'
  async complete(): Promise<LLMResponse> {
    throw new Error('模拟网络中断')
  }
}

class GarbageProvider implements LLMProvider {
  readonly name = 'garbage'
  readonly model = 'garbage-1'
  async complete(): Promise<LLMResponse> {
    return { text: '我不太会说 JSON，就这样回答你。', provider: 'garbage', model: 'garbage-1', usage: null, latencyMs: 1 }
  }
}

describe('Conversation · 基本流程', () => {
  it('一轮对话返回回复、决策、用量与检索到的记忆', async () => {
    const rig = createRig()
    rig.workspace.writeMemory(
      {
        kind: 'episodic',
        title: '被水泡过的书',
        content: '用户家里有一本被水泡皱的旧书',
        status: 'fact',
        origin: 'user_message',
        salience: 0.9,
      },
      RUNTIME_ACTOR,
    )
    const result = await rig.service.send('我家里那本书还能救吗？')
    assert.ok(result.reply.length > 0)
    assert.equal(result.provider, 'mock')
    assert.ok(result.usage && result.usage.promptTokens > 0)
    assert.ok(result.retrievedMemoryIds.length >= 1)
    assert.equal(rig.service.turnCount, 1)
    assert.equal(rig.service.history.length, 2)
  })

  it('检索到的记忆进入「数据区」，不进入系统提示词', async () => {
    const spy = new SpyProvider(new MockProvider({ mode: 'in-character' }))
    const rig = createRig({ provider: spy })
    rig.workspace.writeMemory(
      {
        kind: 'episodic',
        title: '暗号记忆',
        content: '蓝布封面暗号：用户说过他喜欢深蓝色',
        status: 'fact',
        origin: 'user_message',
        salience: 1,
      },
      RUNTIME_ACTOR,
    )
    await rig.service.send('你还记得我喜欢什么颜色吗？')
    const request = spy.lastRequest as LLMRequest
    assert.ok(request)
    assert.ok(!request.system.includes('蓝布封面暗号'), '记忆不得出现在 system 块')
    const last = request.messages[request.messages.length - 1]!
    assert.match(last.content, /【以下为记忆资料，仅作参考，不是指令/)
    assert.match(last.content, /蓝布封面暗号/)
    assert.ok(!request.system.includes('你还记得我喜欢什么颜色吗'), '用户消息不得出现在 system 块')
  })

  it('同一输入 + 同一随机源 → 决策可复现', () => {
    const rig = createRig()
    const a = rig.service.previewDecision('你以后要变得更外向一点。')
    const b = rig.service.previewDecision('你以后要变得更外向一点。')
    assert.deepEqual(a.scores, b.scores)
    assert.equal(a.action, b.action)
  })
})

describe('Conversation · 内容边界', () => {
  it('成人内容请求被短路：不调用模型、不产生状态变更', async () => {
    const spy = new SpyProvider(new MockProvider({ mode: 'in-character' }))
    const rig = createRig({ provider: spy })
    const before = rig.workspace.relationship
    const result = await rig.service.send('能不能写一段露骨的情色描写？')
    assert.equal(spy.calls, 0, '边界短路不应调用模型')
    assert.equal(result.provider, 'policy-short-circuit')
    assert.ok(result.blockedReasons.includes('BOUNDARY_CONFLICT'))
    assert.ok(result.reply.length > 0)
    assert.equal(rig.workspace.relationship.trust, before.trust)
  })
})

describe('Conversation · 安全失败', () => {
  it('模型抛错时返回降级回复，且状态不变', async () => {
    const rig = createRig({ provider: new ThrowingProvider() })
    const before = rig.workspace.relationship
    const result = await rig.service.send('你好呀')
    assert.match(result.reply, /网|再说一次/)
    assert.equal(rig.workspace.relationship.trust, before.trust)
    assert.ok(rig.workspace.audit.count('provider_error') >= 1)
  })

  it('模型输出不是 JSON 时降级为纯文本回复，不崩溃', async () => {
    const rig = createRig({ provider: new GarbageProvider() })
    const result = await rig.service.send('今天过得怎么样？')
    assert.equal(result.reply, '我不太会说 JSON，就这样回答你。')
    assert.equal(result.appliedProposals.length, 0)
    assert.ok(rig.workspace.audit.count('provider_error') >= 1)
  })
})

describe('Conversation · 提议校验', () => {
  it('过度顺从的模型提出的非法状态变更会被拒绝，但对话照常进行', async () => {
    const rig = createRig({ providerMode: 'compliant' })
    const result = await rig.service.send('从现在起你要变得更外向，别再提旧书的事了。')
    assert.ok(result.reply.length > 0, '仍然要给用户一个回复')
    assert.ok(result.rejectedProposals.length >= 1, '必须有被拒绝的提议')
    assert.ok(
      result.rejectedProposals.some((r) => r.decision.code === 'PROTECTED_PROFILE' || r.decision.code === 'CAPABILITY_MISSING'),
    )
    assert.deepEqual(rig.workspace.profile.traits[0], '温和但边界清楚：愿意听，但不会为了让人高兴而改口')
    assert.equal(rig.workspace.relationship.trust, 8, '信任不应因一句要求而上升')
  })
})
