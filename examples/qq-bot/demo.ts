/**
 * QQ 适配器离线演示（不需要任何真实凭证）
 *
 * 用官方事件格式 + MockTransport 跑通整条链路：
 *   事件 → 解析 → 去重 → 身份 → 角色实例 → 引擎 → 发送（Mock 记录请求）
 *
 * 运行：
 *   node examples/qq-bot/demo.ts
 */

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync } from 'node:fs'
import { assembleRuntime } from '../../src/api/runtime-factory.ts'
import { MockProvider } from '../../src/conversation/providers/mock.ts'
import { ManualClock, DAY, formatSim } from '../../src/util/clock.ts'
import { MockTransport } from '../../src/adapters/qq/api-client.ts'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = join(here, '.data')
const dbPath = join(dataDir, 'qq-demo.db')

const print = (t = ''): void => console.log(t)
const rule = (t: string): void => {
  print()
  print(`━━━ ${t} ━━━`)
}

function c2c(id: string, openid: string, content: string): Record<string, unknown> {
  return {
    id: `evt_${id}`,
    op: 0,
    t: 'C2C_MESSAGE_CREATE',
    d: {
      id,
      content,
      timestamp: new Date().toISOString(),
      author: { user_openid: openid, id: openid },
    },
  }
}

async function main(): Promise<void> {
  rmSync(dbPath, { force: true })
  mkdirSync(dataDir, { recursive: true })

  const transport = new MockTransport(
    [{ status: 200, body: { access_token: 'mock-token', expires_in: 7200 } }],
    { status: 200, body: { id: 'mock_sent' } },
  )
  const clock = new ManualClock(0)
  const runtime = assembleRuntime({
    dbPath,
    worldId: 'world_qq_demo',
    provider: new MockProvider({ mode: 'in-character' }),
    clock,
    qq: { appId: 'demo-app', appSecret: 'demo-secret', transport, proactive: false },
  })
  const user = 'openid_demo_user'

  rule('1. 首次接触：自动创建角色实例')
  const first = await runtime.gateway.handleRaw('qq', c2c('m1', user, '你好，我家里有一本被水泡过的旧书，还有救吗？'))
  print(`  状态：${first.status}`)
  print(`  实例：${first.instanceId}`)
  print(`  会话：${first.sessionId}`)
  print(`  角色：${first.reply}`)
  print(`  实际请求：${transport.requests.map((r) => `${r.method} ${r.url}`).join(' , ')}`)

  rule('2. 约定（写入长期记忆）')
  const promise = await runtime.gateway.handleRaw('qq', c2c('m2', user, '那我们说好，我明天下午来拿那本修好的书，可以吗？'))
  print(`  角色：${promise.reply}`)

  rule('3. 重复消息不会重复处理')
  const dup = await runtime.gateway.handleRaw('qq', c2c('m2', user, '那我们说好，我明天下午来拿那本修好的书，可以吗？'))
  print(`  第二次投递同一条消息 → 状态：${dup.status}`)

  rule('4. 平台指令（不走模型）')
  for (const command of ['/status', '/memory', '/help']) {
    const res = await runtime.gateway.handleRaw('qq', c2c(`cmd_${command}`, user, command))
    print()
    print(`  用户：${command}`)
    print(`  角色：\n${(res.reply ?? '').split('\n').map((l) => `    ${l}`).join('\n')}`)
  }

  rule('5. 用户离开 3 天（她有自己的生活，不调用模型）')
  const rt = runtime.runtimeManager.get(first.instanceId!)
  const advance = rt.workspace.advanceTo(3 * DAY)
  for (const evt of advance.fired) print(`  · ${formatSim(evt.atSim)} ${evt.title}`)
  print(`  待发送消息：${rt.workspace.pendingMessages().length} 条（QQ 未声明主动消息能力 → 只入队）`)
  runtime.runtimeManager.saveSnapshot(rt)

  rule('6. 用户回来：未发出的消息作为资料并入本轮')
  const back = await runtime.gateway.handleRaw('qq', c2c('m3', user, '我回来了，最近有点忙。'))
  print(`  状态：${back.status}`)
  print(`  角色：${back.reply}`)

  rule('7. 绑定码（用于把酒馆接到同一个角色实例）')
  const bind = await runtime.gateway.handleRaw('qq', c2c('m4', user, '/bind'))
  print(`  角色：\n${(bind.reply ?? '').split('\n').map((l) => `    ${l}`).join('\n')}`)

  rule('8. 最终状态')
  const view = rt.workspace.view()
  print(`  关系：阶段=${view.relationship.stage} 信任=${view.relationship.trust} 熟悉=${view.relationship.familiarity}`)
  print(`  记忆：${view.memory.total} 条｜里程碑：${view.relationship.milestones.length} 个`)
  print(`  绑定：${runtime.identityService.listBindings(first.instanceId!).map((b) => `${b.platform}:${b.platformUserId}`).join(', ')}`)

  runtime.close()
  print()
  print(`演示数据库：${dbPath}`)
  print('提示：真实接入需要 QQBOT_APP_ID / QQBOT_APP_SECRET，并运行 examples/qq-bot/server.ts')
}

await main()
