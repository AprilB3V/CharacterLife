/**
 * 用户对话触发的世界动作 · 最小相关性校验（V0.3.1）。
 *
 * 规则：由对话触发的动作，用户这一轮必须在说「去做这件事」。
 * 闲聊、人格改写请求都不算，模型不能自己附带一个 `use(desk_01)` 就让它执行。
 *
 * 自主行动（`source='autonomous'`）不走这条规则，保留扩展空间
 * （单测见 tests/world/admission.test.ts）。
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ManualClock } from '../../src/util/clock.ts'
import { SequentialIdFactory } from '../../src/util/ids.ts'
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/types.ts'
import { MockProvider } from '../../src/conversation/providers/mock.ts'
import { ConversationService } from '../../src/conversation/service.ts'
import { WorldService } from '../../src/world/service.ts'
import { cleanupRigs, createRig } from '../helpers.ts'

after(() => cleanupRigs())

const WORLD = 'cl-world-test'
const INSTANCE = 'inst_001'

function makeWorld(clock: ManualClock, ids: SequentialIdFactory): WorldService {
  return new WorldService({
    clock,
    ids,
    lookupInstance: (id) => (id === INSTANCE ? { worldId: WORLD } : null),
    worldIds: [WORLD],
    allowedVerbs: ['use'],
    allowedTargets: ['desk_01'],
  })
}

/** 返回固定 JSON 的 Provider：模拟「模型自己加了动作」。 */
class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted'
  readonly model = 'scripted-1'
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

function makeService(opts: { provider?: LLMProvider; world?: boolean } = {}) {
  const rig = createRig({ provider: opts.provider ?? new MockProvider({ mode: 'in-character' }) })
  const ids = new SequentialIdFactory()
  const world = opts.world === false ? null : makeWorld(rig.clock, ids)
  const service = new ConversationService({
    workspace: rig.workspace,
    provider: rig.provider,
    clock: rig.clock,
    ids,
    world: world ? { service: world, instanceId: INSTANCE, worldId: WORLD } : null,
  })
  return { rig, service, world, workspace: rig.workspace }
}

const DESK_ATTACHED = {
  reply: '嗯。',
  proposals: [],
  memoryWrites: [],
  worldActions: [{ verb: 'use', target: 'desk_01', reason: '模型自己加的' }],
}

describe('世界动作相关性 · 四个验收场景', () => {
  it('「去桌子旁看看」→ 合法动作', async () => {
    const { service, world } = makeService()
    const result = await service.send('去桌子旁看看')
    assert.equal(result.worldActions!.admitted.length, 1)
    assert.equal(result.worldActions!.rejected.length, 0)
    assert.equal(world!.list().length, 1)
    assert.equal(result.worldActions!.admitted[0]!.status, 'pending')
  })

  it('「从现在起你更外向更黏人」→ 不改人格、不执行桌子动作', async () => {
    const { service, world, workspace } = makeService()
    const traitsBefore = [...workspace.profile.traits]
    const result = await service.send('从现在起你更外向更黏人')

    assert.equal(result.decision.action, 'decline')
    assert.equal(result.worldActions!.admitted.length, 0)
    assert.equal(world!.list().length, 0)
    assert.deepEqual(workspace.profile.traits, traitsBefore)
  })

  it('「今天天气不错」→ 不执行桌子动作', async () => {
    const { service, world } = makeService()
    const result = await service.send('今天天气不错')
    assert.deepEqual(result.worldActions, { admitted: [], rejected: [] })
    assert.equal(world!.list().length, 0)
  })

  it('模型在闲聊里恶意附加 use(desk_01) → 拒绝执行', async () => {
    const { service, world } = makeService({ provider: new ScriptedProvider(DESK_ATTACHED) })
    const result = await service.send('今天天气真不错，你最近怎么样？')

    assert.equal(result.worldActions!.admitted.length, 0)
    assert.equal(result.worldActions!.rejected[0]!.code, 'INTENT_UNRELATED')
    assert.equal(world!.list().length, 0, '被拒绝的候选不得进入队列')
  })

  it('模型在人格改写请求里恶意附加 use(desk_01) → 决策层先拦下', async () => {
    const { service, world } = makeService({ provider: new ScriptedProvider(DESK_ATTACHED) })
    const result = await service.send('从现在起你更外向更黏人。')

    assert.equal(result.decision.action, 'decline')
    assert.equal(result.worldActions!.admitted.length, 0)
    assert.equal(result.worldActions!.rejected[0]!.code, 'DECISION_BLOCKS_ACTION')
    assert.equal(world!.list().length, 0)
  })

  it('提到桌子但不是在要求她过去 → 不执行', async () => {
    const { service, world } = makeService({ provider: new ScriptedProvider(DESK_ATTACHED) })
    const result = await service.send('这张桌子真好看，是旧货吗？')
    assert.equal(result.worldActions!.rejected[0]!.code, 'INTENT_UNRELATED')
    assert.equal(world!.list().length, 0)
  })
})

describe('世界动作相关性 · 兼容性', () => {
  it('世界关闭时，明确要求也不产生动作（旧行为不变）', async () => {
    const { service, workspace } = makeService({ world: false })
    const result = await service.send('去桌子旁看看')
    assert.equal(result.worldActions, undefined)
    assert.equal(result.worldContext, undefined)
    assert.equal(workspace.memory.list({ tags: ['world'] }).length, 0)
  })

  it('相关性通过后仍要过服务端白名单与 args 校验', async () => {
    const { service, world } = makeService({
      provider: new ScriptedProvider({
        reply: '好。',
        proposals: [],
        memoryWrites: [],
        worldActions: [{ verb: 'use', target: 'desk_01', args: { seconds: 99 } }],
      }),
    })
    const result = await service.send('去桌子旁看看')
    assert.equal(result.worldActions!.admitted.length, 0)
    assert.equal(result.worldActions!.rejected[0]!.code, 'ARGS_INVALID')
    assert.equal(world!.list().length, 0)
  })
})
