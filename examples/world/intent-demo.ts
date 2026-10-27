/**
 * 模型驱动世界动作 · 闭环演示（离线 · 确定性 · 零成本）
 *
 * 演示四件事：
 *   1. 用户说「去桌子旁看看」→ 模型产出世界动作候选 → 准入 → WorldService 登记；
 *   2. 箱庭领取 → 回执成功 → 下一轮模型上下文把「已确认成功」与「未确认」分开；
 *   3. 箱庭不上线时，动作只能停在未确认，绝不能被描述成已完成；
 *   4. 普通聊天不产生任何世界动作。
 *
 * 运行：npm run world:intent
 */

import { assembleRuntime } from '../../src/api/runtime-factory.ts'
import { MockProvider } from '../../src/conversation/providers/mock.ts'
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/types.ts'
import { buildWorldEventContext, worldContextLines } from '../../src/kernel/world/observation.ts'

const WORLD = 'cl-world-demo'

/** 记录最近一次请求的 system，用来展示"模型下一轮到底看到了什么"。 */
class RecordingProvider implements LLMProvider {
  readonly name = 'mock-recording'
  readonly model: string
  #inner: LLMProvider
  lastSystem = ''
  constructor(inner: LLMProvider) {
    this.#inner = inner
    this.model = inner.model
  }
  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.lastSystem = request.system
    return this.#inner.complete(request)
  }
}

function head(title: string): void {
  console.log('')
  console.log(`── ${title} ${'─'.repeat(Math.max(0, 68 - title.length))}`)
}

/** 只截出系统块里的世界段落，避免整段提示词刷屏。 */
function worldSection(system: string): string {
  const start = system.indexOf('【世界交互】')
  if (start < 0) return '（提示词里没有世界段落：世界未启用）'
  const end = system.indexOf('【本轮行为决策', start)
  return system.slice(start, end < 0 ? undefined : end).trim()
}

async function main(): Promise<void> {
  const provider = new RecordingProvider(new MockProvider({ mode: 'in-character' }))
  const runtime = assembleRuntime({
    dbPath: ':memory:',
    worldId: WORLD,
    provider,
    world: { enabled: true, worldIds: [WORLD], allowedVerbs: ['use'], allowedTargets: ['desk_01'] },
  })
  const instanceId = runtime.identityService.resolveOrCreate('world', 'intent-demo').instance.id
  const rt = runtime.runtimeManager.get(instanceId)
  const world = runtime.world!
  const send = (text: string) => runtime.runtimeManager.send(rt, { identityKey: 'world:intent-demo', text })

  head('0. 本轮开始时模型看到的世界能力清单')
  console.log(worldSection(provider.lastSystem) || '（第一轮还没调用模型）')

  head('1. 用户：你能帮我去桌子旁看看吗？')
  const first = await send('你能帮我去桌子旁看看吗？')
  console.log(`回复：${first.reply}`)
  console.log(`动作准入：${JSON.stringify(first.worldActions, null, 2)}`)

  const actionId = first.worldActions?.admitted[0]?.actionId
  if (!actionId) throw new Error('模型没有产出合法动作')

  head('2. 模型下一轮看到的世界段落（动作尚未被领取）')
  console.log(worldSection(provider.lastSystem) || '（还没到下一轮）')
  await send('辛苦了。')
  console.log('')
  console.log('实际传给模型的系统块片段：')
  console.log(worldSection(provider.lastSystem))

  head('3. 箱庭领取并回报成功 → 下一轮只把这条写成「成功」')
  const leased = world.lease(WORLD, 4)
  console.log(`领取：${leased.map((a) => `${a.actionId} ${a.verb}(${a.target})`).join(', ')}`)
  const reported = world.ingest(WORLD, [
    {
      eventId: 'evt_demo_001',
      instanceId,
      actionId,
      kind: 'action_result',
      result: 'succeeded',
      atWorldTimeMs: 128_900,
      summary: '桌上的纸被碰歪了一点（这段文本不会进入系统块）',
      facts: [{ key: 'desk_01.used', value: true }],
      code: null,
    },
  ])
  console.log(`回执：${JSON.stringify(reported)}`)

  await send('刚才那件事怎么样了？')
  console.log('')
  console.log(worldSection(provider.lastSystem))

  head('4. 再提一个动作，但箱庭不上线（离线）')
  const offline = await send('再去桌子旁看看那边的情况吧。')
  console.log(`动作准入：${JSON.stringify(offline.worldActions)}`)
  console.log(`本轮上下文：${JSON.stringify(worldContextLines(offline.worldContext!))}`)

  await send('辛苦了。')
  console.log('')
  console.log(worldSection(provider.lastSystem))
  console.log('')
  console.log('注意：离线时它只说「已提出 / 还没领取」或「结果未知」，不会说已经做完。')

  head('5. 普通聊天不产生世界动作')
  const chitchat = await send('今天天气不错。')
  console.log(`worldActions = ${JSON.stringify(chitchat.worldActions)}`)

  head('6. 本进程上下文（不是跨会话世界记忆）')
  const context = buildWorldEventContext(world.list({ instanceId }))
  console.log(JSON.stringify({ source: context.source, persistent: context.persistent, counts: {
    confirmed: context.confirmed.length,
    unconfirmed: context.unconfirmed.length,
  } }, null, 2))
  console.log(`世界事实记忆条数（本阶段恒为 0）：${rt.workspace.memory.list({ tags: ['world'] }).length}`)

  runtime.close()
  head('演示结束')
}

void main().catch((err: unknown) => {
  console.error('演示失败：', err instanceof Error ? err.stack : err)
  process.exit(1)
})
