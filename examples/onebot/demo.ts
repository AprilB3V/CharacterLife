/**
 * OneBot 适配器离线演示（不需要网关、不需要 QQ 号、不需要任何凭证）
 *
 * 用 OneBot 11 的标准事件格式 + MockTransport 跑通整条链路：
 *   事件 → 解析（含群 @ 过滤）→ 去重 → 身份（QQ 号匿名化）→ 角色实例 → 引擎 → 发送
 *
 * 运行：
 *   node examples/onebot/demo.ts
 */

import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, rmSync } from 'node:fs'
import { assembleRuntime } from '../../src/api/runtime-factory.ts'
import { MockProvider } from '../../src/conversation/providers/mock.ts'
import { ManualClock, DAY, formatSim } from '../../src/kernel/util/clock.ts'
import { MockTransport } from '../../src/adapters/onebot/api-client.ts'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = join(here, '.data')
const dbPath = join(dataDir, 'onebot-demo.db')

const SELF_ID = 10001
const USER_ID = 20002
const OTHER_ID = 20003
const GROUP_ID = 30003

const print = (t = ''): void => console.log(t)
const rule = (t: string): void => {
  print()
  print(`━━━ ${t} ━━━`)
}

function segments(text: string, atSelf = false): Array<Record<string, unknown>> {
  const segs: Array<Record<string, unknown>> = []
  if (atSelf) segs.push({ type: 'at', data: { qq: String(SELF_ID) } })
  segs.push({ type: 'text', data: { text } })
  return segs
}

function privateEvent(id: string, userId: number, text: string, time?: number): Record<string, unknown> {
  return {
    time: time ?? Math.floor(Date.now() / 1000),
    self_id: SELF_ID,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: id,
    user_id: userId,
    message: segments(text),
    raw_message: text,
    sender: { user_id: userId, nickname: '读者' },
  }
}

function groupEvent(id: string, userId: number, text: string, atSelf: boolean): Record<string, unknown> {
  const message = segments(text, atSelf)
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: SELF_ID,
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: id,
    group_id: GROUP_ID,
    user_id: userId,
    message,
    raw_message: `${atSelf ? `[CQ:at,qq=${SELF_ID}] ` : ''}${text}`,
    sender: { user_id: userId, nickname: '群友', card: '群友' },
  }
}

async function main(): Promise<void> {
  rmSync(dbPath, { force: true })
  mkdirSync(dataDir, { recursive: true })

  const transport = new MockTransport([], { status: 200, body: { status: 'ok', retcode: 0, data: { message_id: 9001 } } })
  const clock = new ManualClock(0)
  const runtime = assembleRuntime({
    dbPath,
    worldId: 'world_onebot_demo',
    provider: new MockProvider({ mode: 'in-character' }),
    clock,
    onebot: {
      baseUrl: 'http://127.0.0.1:3000',
      accessToken: 'demo-token',
      transport,
      proactive: true,
      parse: { selfId: SELF_ID },
    },
  })

  rule('1. 私聊首次接触：自动创建角色实例')
  const first = await runtime.gateway.handleRaw('onebot', privateEvent('m1', USER_ID, '你好，我家里有一本被水泡过的旧书，还有救吗？'))
  print(`  状态：${first.status}`)
  print(`  实例：${first.instanceId}`)
  print(`  会话：${first.sessionId}`)
  print(`  角色：${first.reply}`)
  print(`  实际请求：${transport.requests.map((r) => r.url.replace(/^http:\/\/127\.0\.0\.1:3000\//, '')).join(', ')}`)
  const sentBody = transport.callsTo('send_private_msg')[0]?.body as Record<string, unknown>
  print(`  发送体：user_id=${String(sentBody.user_id)} auto_escape=${String(sentBody.auto_escape)}`)

  rule('2. 群聊：只有被 @ 才回应')
  const plain = await runtime.gateway.handleRaw('onebot', groupEvent('g1', OTHER_ID, '今天天气不错', false))
  print(`  未 @ 的群消息 → 状态：${plain.status}（原因：${plain.reason}，没有调用模型）`)
  const mention = await runtime.gateway.handleRaw('onebot', groupEvent('g2', OTHER_ID, '你好，请问旧书怎么保存？', true))
  print(`  @ 了机器人 → 状态：${mention.status}`)
  print(`  角色：${mention.reply}`)
  print(`  发送目标：${JSON.stringify((transport.lastRequest()?.body as Record<string, unknown>)?.group_id)}（群，不是私聊）`)

  rule('3. 群里的指令不需要 @（否则没人知道怎么用）')
  const cmd = await runtime.gateway.handleRaw('onebot', groupEvent('g3', OTHER_ID, '/help', false))
  print(`  状态：${cmd.status}`)
  print(`  角色：\n${(cmd.reply ?? '').split('\n').map((l) => `    ${l}`).join('\n')}`)

  rule('4. 重复上报不会重复处理（网关重投很常见）')
  const dup = await runtime.gateway.handleRaw('onebot', privateEvent('m2', USER_ID, '那我们说好，我明天下午来拿书。'))
  const again = await runtime.gateway.handleRaw('onebot', privateEvent('m2', USER_ID, '那我们说好，我明天下午来拿书。'))
  print(`  第一次：${dup.status}｜第二次投递同一条：${again.status}`)

  rule('5. 隐私：数据库里没有 QQ 号')
  const bindings = runtime.identityService.listBindings(first.instanceId!)
  for (const b of bindings) {
    print(`  ${b.platform} → ${b.platformUserId}`)
  }
  print(`  原始 QQ 号 ${USER_ID} 是否出现在平台身份里：${bindings.some((b) => b.platformUserId.includes(String(USER_ID))) ? '是（不该发生）' : '否'}`)

  rule('6. 用户离开 3 天（她有自己的生活，不调用模型）')
  const rt = runtime.runtimeManager.get(first.instanceId!)
  const advance = rt.workspace.advanceTo(3 * DAY)
  for (const evt of advance.fired) print(`  · ${formatSim(evt.atSim)} ${evt.title}`)
  print(`  待发送消息：${rt.workspace.pendingMessages().length} 条`)
  runtime.runtimeManager.saveSnapshot(rt)

  rule('7. 用户回来：OneBot 能主动推送，所以待发送消息先发出去（与 QQ 的关键差异）')
  const before = transport.callsTo('send_private_msg').length
  const back = await runtime.gateway.handleRaw('onebot', privateEvent('m3', USER_ID, '我回来了，最近有点忙。'))
  const after = transport.callsTo('send_private_msg').length
  print(`  本轮私聊发送次数：${after - before}（1 = 主动消息 + 1 条回复 = 2 才算推送成功）`)
  print(`  状态：${back.status}`)
  print(`  角色：${back.reply}`)

  rule('8. 绑定码（把酒馆接到同一个角色实例）')
  const bind = await runtime.gateway.handleRaw('onebot', privateEvent('m4', USER_ID, '/bind'))
  print(`  角色：\n${(bind.reply ?? '').split('\n').map((l) => `    ${l}`).join('\n')}`)

  rule('9. 最终状态')
  const view = rt.workspace.view()
  print(`  关系：阶段=${view.relationship.stage} 信任=${view.relationship.trust} 熟悉=${view.relationship.familiarity}`)
  print(`  记忆：${view.memory.total} 条｜里程碑：${view.relationship.milestones.length} 个`)
  print(`  群聊实例（另一个用户）：${mention.instanceId}`)
  print(`  实例是否隔离：${mention.instanceId !== first.instanceId ? '是' : '否（不该发生）'}`)

  runtime.close()
  print()
  print(`演示数据库：${dbPath}`)
  print('提示：真实接入需要网关（NapCat / Lagrange.OneBot / SnowLuma）与 ONEBOT_API_BASE，')
  print('      然后运行 examples/onebot/server.ts，把网关的 HTTP 上报地址指向 /onebot/event。')
}

await main()
