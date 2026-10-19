/**
 * 适配层测试辅助：一套可跑通的运行时（SQLite 临时库 + Mock Provider + Mock QQ 传输）。
 */

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { assembleRuntime } from '../../src/api/runtime-factory.ts'
import type { RuntimeBundle } from '../../src/api/runtime-factory.ts'
import { MockProvider } from '../../src/conversation/providers/mock.ts'
import { ManualClock } from '../../src/util/clock.ts'
import { MockTransport } from '../../src/adapters/qq/api-client.ts'
import { QQApiClient } from '../../src/adapters/qq/api-client.ts'
import { QQAdapter } from '../../src/adapters/qq/adapter.ts'
import { MockTransport as OneBotMockTransport } from '../../src/adapters/onebot/api-client.ts'
import type { OneBotParseOptions } from '../../src/adapters/onebot/events.ts'
import { OneBotAdapter } from '../../src/adapters/onebot/adapter.ts'

export const ADAPTER_DATA = join(process.cwd(), 'tests', '.data', 'adapters')
let counter = 0
const dirs: string[] = []

export function freshDir(): string {
  const dir = join(ADAPTER_DATA, `case_${++counter}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  dirs.push(dir)
  return dir
}

export function cleanupDirs(): void {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

export interface RigOptions {
  dbPath?: string
  clock?: ManualClock
  qqProactive?: boolean
  transport?: MockTransport
}

export interface Rig {
  runtime: RuntimeBundle
  clock: ManualClock
  transport: MockTransport
  qq: QQAdapter
  dbPath: string
}

export function makeRig(opts: RigOptions = {}): Rig {
  const dir = opts.dbPath ? null : freshDir()
  const dbPath = opts.dbPath ?? join(dir!, 'adapter.db')
  const clock = opts.clock ?? new ManualClock(0)
  const transport = opts.transport ?? new MockTransport()
  const runtime = assembleRuntime({
    dbPath,
    worldId: 'world_test',
    provider: new MockProvider({ mode: 'in-character' }),
    clock,
    qq: {
      appId: 'test-app',
      appSecret: 'test-secret',
      transport,
      proactive: opts.qqProactive === true,
    },
  })
  const qq = runtime.qqAdapter!
  return { runtime, clock, transport, qq, dbPath }
}

/** 构造一条 C2C 消息事件（字段与 QQ 官方 v2 事件一致）。 */
export function c2cEvent(opts: {
  id: string
  openid: string
  content: string
  timestamp?: number
}): Record<string, unknown> {
  return {
    id: `evt_${opts.id}`,
    op: 0,
    t: 'C2C_MESSAGE_CREATE',
    d: {
      id: opts.id,
      content: opts.content,
      timestamp: new Date(opts.timestamp ?? Date.now()).toISOString(),
      author: { user_openid: opts.openid, id: opts.openid },
    },
  }
}

export function groupEvent(opts: {
  id: string
  openid: string
  groupOpenid: string
  content: string
}): Record<string, unknown> {
  return {
    id: `evt_${opts.id}`,
    op: 0,
    t: 'GROUP_AT_MESSAGE_CREATE',
    d: {
      id: opts.id,
      content: opts.content,
      timestamp: new Date().toISOString(),
      group_openid: opts.groupOpenid,
      author: { member_openid: opts.openid, id: opts.openid },
    },
  }
}

export function guildEvent(opts: { id: string; userId: string; channelId: string; content: string }): Record<string, unknown> {
  return {
    id: `evt_${opts.id}`,
    op: 0,
    t: 'AT_MESSAGE_CREATE',
    d: {
      id: opts.id,
      content: opts.content,
      timestamp: new Date().toISOString(),
      channel_id: opts.channelId,
      guild_id: 'guild_1',
      author: { id: opts.userId },
    },
  }
}

export function makeQQAdapter(transport: MockTransport, proactive = false): QQAdapter {
  const client = new QQApiClient({
    transport,
    credentials: { appId: 'test-app', appSecret: 'test-secret' },
  })
  return new QQAdapter({ client, capabilities: { proactive } })
}

/* ────────────────────────────── OneBot 11 ────────────────────────────── */

export interface OneBotRigOptions {
  dbPath?: string
  clock?: ManualClock
  /** 网关 API 传输（默认 MockTransport，永不发真实请求） */
  transport?: OneBotMockTransport
  proactive?: boolean
  parse?: OneBotParseOptions
}

export interface OneBotRig {
  runtime: RuntimeBundle
  clock: ManualClock
  transport: OneBotMockTransport
  adapter: OneBotAdapter
  dbPath: string
}

/** 一套「OneBot 网关 + 角色引擎」的离线测试装置。 */
export function makeOneBotRig(opts: OneBotRigOptions = {}): OneBotRig {
  const dir = opts.dbPath ? null : freshDir()
  const dbPath = opts.dbPath ?? join(dir!, 'onebot.db')
  const clock = opts.clock ?? new ManualClock(0)
  const transport = opts.transport ?? new OneBotMockTransport()
  const runtime = assembleRuntime({
    dbPath,
    worldId: 'world_onebot_test',
    provider: new MockProvider({ mode: 'in-character' }),
    clock,
    onebot: {
      baseUrl: 'http://127.0.0.1:3000',
      accessToken: 'test-token',
      transport,
      proactive: opts.proactive !== false,
      parse: opts.parse,
    },
  })
  return { runtime, clock, transport, adapter: runtime.onebotAdapter!, dbPath }
}

export const ONEBOT_SELF_ID = 10001

/** OneBot 11 私聊事件。 */
export function oneBotPrivateEvent(opts: {
  id: string | number
  userId: number
  text: string
  selfId?: number
  time?: number
}): Record<string, unknown> {
  return {
    time: opts.time ?? Math.floor(Date.now() / 1000),
    self_id: opts.selfId ?? ONEBOT_SELF_ID,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: opts.id,
    user_id: opts.userId,
    message: [{ type: 'text', data: { text: opts.text } }],
    raw_message: opts.text,
    sender: { user_id: opts.userId, nickname: '测试用户' },
  }
}

/** OneBot 11 群消息事件；`atSelf` 决定是否带 [CQ:at,qq=self]。 */
export function oneBotGroupEvent(opts: {
  id: string | number
  userId: number
  groupId: number
  text: string
  atSelf: boolean
  selfId?: number
}): Record<string, unknown> {
  const selfId = opts.selfId ?? ONEBOT_SELF_ID
  const message: Array<Record<string, unknown>> = []
  if (opts.atSelf) message.push({ type: 'at', data: { qq: String(selfId) } })
  message.push({ type: 'text', data: { text: opts.text } })
  return {
    time: Math.floor(Date.now() / 1000),
    self_id: selfId,
    post_type: 'message',
    message_type: 'group',
    sub_type: 'normal',
    message_id: opts.id,
    group_id: opts.groupId,
    user_id: opts.userId,
    message,
    raw_message: `${opts.atSelf ? `[CQ:at,qq=${selfId}] ` : ''}${opts.text}`,
    sender: { user_id: opts.userId, nickname: '群友', card: '群友' },
  }
}
