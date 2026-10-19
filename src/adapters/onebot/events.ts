/**
 * OneBot 11 事件 → NormalizedMessage。
 *
 * OneBot 11 是「QQ 号 + 网关程序（NapCat / Lagrange.OneBot / SnowLuma …）」的事实标准，
 * 与本项目已有的 QQ 官方适配器互不干扰：
 *
 *   QQ 官方机器人：openid + Webhook 签名 + 被动回复窗口（60 分钟 / 5 分钟）
 *   OneBot    ：QQ 号 / 群号 + 网关 HTTP 上报 + 无平台窗口限制（网关自己控频）
 *
 * 只做协议转换，不做身份判定、不写库。两个关键取舍：
 *
 * 1. **默认匿名化 QQ 号**：OneBot 的 `user_id` 是真实 QQ 号（个人信息）。默认把它哈希成
 *    `qq_<16 位 hex>` 再落库，保证「数据库里没有 QQ 号」这条隐私承诺对 OneBot 也成立。
 *    哈希不带盐、确定性，所以同一个人跨重启、跨群/私聊仍是同一个假名。
 * 2. **群聊默认只在被 @ 时响应**：OneBot 网关会把群里**所有**消息上报上来，
 *    不做过滤就会变成刷屏机器人。但 `/help` 这类指令例外（否则群里没人知道怎么用）。
 */

import { createHash } from 'node:crypto'
import type { NormalizedMessage, SceneKind } from '../protocol.ts'
import { InboundParseError } from '../protocol.ts'

export interface OneBotParseOptions {
  /** 机器人自己的 QQ 号；事件里有 `self_id` 时优先用事件里的 */
  selfId?: string | number | null
  /** 群聊是否只在被 @ 时响应（默认 true）。设成 false = 群里每条消息都回，慎用 */
  groupMentionOnly?: boolean
  /** 群聊里 `/<命令>` 是否无需 @ 也能触发（默认 true） */
  allowGroupCommands?: boolean
  /** 是否把 QQ 号哈希成假名（默认 true）。false = 数据库里存真实 QQ 号 */
  anonymizeUserIds?: boolean
  /** 是否把昵称/群名片带进 displayName（默认 false，只要展示用） */
  captureNickname?: boolean
}

export interface OneBotReplyTarget {
  scene: 'c2c' | 'group'
  /** c2c: user_id；group: group_id */
  target: string
}

export function encodeReplyTarget(target: OneBotReplyTarget): string {
  return JSON.stringify(target)
}

export function decodeReplyTarget(raw: string): OneBotReplyTarget {
  try {
    const parsed = JSON.parse(raw) as OneBotReplyTarget
    if ((parsed.scene === 'c2c' || parsed.scene === 'group') && typeof parsed.target === 'string' && parsed.target.length > 0) {
      return parsed
    }
  } catch {
    /* 落到下面统一报错 */
  }
  throw new InboundParseError(`非法 OneBot replyTarget: ${raw.slice(0, 80)}`)
}

/** CQ 码实体反转义（OneBot 规范里 `[` `]` `,` `&` 会被转义）。 */
export function decodeCQEscapes(text: string): string {
  return text
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&')
}

const CQ_CODE = /\[CQ:([a-zA-Z0-9_.-]+)((?:,[^\]]*)?)\]/g

function cqParam(params: string, key: string): string | null {
  const m = new RegExp(`(?:^|,)${key}=([^,]*)`).exec(params)
  return m?.[1] ?? null
}

/** 去掉 @ 与表情占位等噪声，只保留用户真正说的话。 */
export function sanitizeOneBotText(text: string): string {
  return text
    .replace(/\[CQ:face,[^\]]*\]/g, '')
    .replace(/\[CQ:mface,[^\]]*\]/g, '')
    .replace(/\[CQ:image,[^\]]*\]/g, '[图片]')
    .replace(/\[CQ:record,[^\]]*\]/g, '[语音]')
    .replace(/\[CQ:video,[^\]]*\]/g, '[视频]')
    .replace(/\[CQ:json,[^\]]*\]/g, '[卡片消息]')
    .replace(/\[CQ:([a-zA-Z0-9_.-]+)((?:,[^\]]*)?)\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface ExtractedContent {
  text: string
  /** 是否 @ 了机器人自己 */
  mentionedSelf: boolean
}

function asString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function idOf(value: unknown): string | null {
  const s = asString(value)
  return s ?? null
}

/**
 * 从 `message`（数组段或 CQ 码字符串）里抽取纯文本。
 * OneBot 11 允许两种格式，网关默认发数组，部分实现发 CQ 字符串，两种都要能读。
 */
export function extractContent(message: unknown, rawMessage: unknown, selfId: string | null): ExtractedContent {
  const parts: string[] = []
  let mentionedSelf = false

  const handleCQString = (raw: string): void => {
    const matches = [...raw.matchAll(CQ_CODE)]
    if (matches.length === 0) {
      parts.push(raw)
      return
    }
    let cursor = 0
    for (const m of matches) {
      const index = m.index ?? 0
      if (index > cursor) parts.push(raw.slice(cursor, index))
      const type = m[1]!
      const params = m[2] ?? ''
      if (type === 'at') {
        const qq = cqParam(params, 'qq')
        if (selfId && qq === selfId) mentionedSelf = true
      } else if (type === 'image') {
        parts.push('[图片]')
      } else if (type === 'face' || type === 'mface') {
        /* 表情无信息量，丢弃 */
      } else if (type === 'record') {
        parts.push('[语音]')
      }
      cursor = index + m[0]!.length
    }
    if (cursor < raw.length) parts.push(raw.slice(cursor))
  }

  if (Array.isArray(message)) {
    for (const segment of message) {
      if (!segment || typeof segment !== 'object') continue
      const seg = segment as { type?: unknown; data?: Record<string, unknown> }
      const data = seg.data ?? {}
      switch (seg.type) {
        case 'text':
          if (typeof data.text === 'string') parts.push(data.text)
          break
        case 'at': {
          const qq = asString(data.qq)
          if (selfId && qq === selfId) mentionedSelf = true
          // @全体成员 不当作 @机器人
          break
        }
        case 'image':
          parts.push('[图片]')
          break
        case 'record':
          parts.push('[语音]')
          break
        case 'video':
          parts.push('[视频]')
          break
        case 'face':
        case 'mface':
          break
        case 'reply':
          /* 引用段：回复对象信息，不进正文 */
          break
        default:
          if (typeof data.text === 'string') parts.push(data.text)
      }
    }
  } else if (typeof message === 'string') {
    handleCQString(message)
  } else if (typeof rawMessage === 'string') {
    handleCQString(rawMessage)
  }

  return { text: sanitizeOneBotText(decodeCQEscapes(parts.join(''))), mentionedSelf }
}

function parseTimestamp(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value
  if (typeof value === 'string') {
    const asNumber = Number(value)
    if (Number.isFinite(asNumber) && asNumber > 0) return asNumber < 1e12 ? asNumber * 1000 : asNumber
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Date.now()
}

/**
 * QQ 号 → 稳定假名。
 *
 * 不用盐是有意的：跨进程/跨群/跨私聊要保持同一个身份，否则「同一个人在群里和私聊
 * 是两个角色」——那正是本项目要避免的记忆割裂。代价是假名与实际 QQ 号的对应关系可被
 * 穷举（QQ 号空间不大），所以它只是「数据库里不出现 QQ 号」，不是密码学匿名。
 */
export function anonymizeUserId(userId: string): string {
  return `qq_${createHash('sha256').update(`onebot:${userId}`).digest('hex').slice(0, 16)}`
}

const COMMAND_PREFIX = /^\/[A-Za-z][A-Za-z0-9_-]*/

export function isCommandText(text: string): boolean {
  return COMMAND_PREFIX.test(text)
}

const SCENE_BY_MESSAGE_TYPE: Record<string, SceneKind | undefined> = {
  private: 'c2c',
  group: 'group',
}

/** 解析一条 OneBot 事件；不是消息事件时返回 null。 */
export function parseOneBotEvent(raw: unknown, opts: OneBotParseOptions = {}): NormalizedMessage | null {
  if (!raw || typeof raw !== 'object') throw new InboundParseError('OneBot 事件不是对象')
  const event = raw as Record<string, unknown>

  // meta_event（心跳/生命周期）、notice（戳一戳/撤回）、request（加好友/入群）一律不当作消息
  const postType = asString(event.post_type)
  if (postType !== 'message') return null

  const messageType = asString(event.message_type)
  const scene = messageType ? SCENE_BY_MESSAGE_TYPE[messageType] : undefined
  if (!scene) return null

  const messageId = idOf(event.message_id) ?? idOf(event.real_id)
  if (!messageId) throw new InboundParseError('OneBot 消息事件缺少 message_id')

  const eventSelfId = idOf(event.self_id)
  const selfId = eventSelfId ?? (opts.selfId === undefined || opts.selfId === null ? null : String(opts.selfId))

  const sender = (event.sender && typeof event.sender === 'object' ? event.sender : {}) as Record<string, unknown>
  const userId = idOf(event.user_id) ?? idOf(sender.user_id)
  if (!userId) throw new InboundParseError('OneBot 消息事件缺少 user_id')

  // 机器人自己发的消息（部分网关会回显）不处理，否则会自问自答
  if (selfId && userId === selfId) return null

  const groupId = idOf(event.group_id)
  if (scene === 'group' && !groupId) throw new InboundParseError('OneBot 群消息缺少 group_id')

  const { text, mentionedSelf } = extractContent(event.message, event.raw_message, selfId)

  // 群聊：没被 @ 且不是指令 → 丢弃（不改状态，也不调用模型）
  if (scene === 'group') {
    if (opts.groupMentionOnly !== false && !mentionedSelf) {
      const allowCommands = opts.allowGroupCommands !== false
      if (!(allowCommands && isCommandText(text))) return null
    }
  }

  const sceneId = scene === 'group' ? groupId : null
  const replyTarget: OneBotReplyTarget =
    scene === 'group' ? { scene: 'group', target: groupId! } : { scene: 'c2c', target: userId }

  const anonymize = opts.anonymizeUserIds !== false
  const platformUserId = anonymize ? anonymizeUserId(userId) : userId
  const nickname = opts.captureNickname === true ? (asString(sender.card) ?? asString(sender.nickname) ?? undefined) : undefined

  return {
    platform: 'onebot',
    platformMessageId: messageId,
    identity: {
      platform: 'onebot',
      platformUserId,
      displayName: nickname,
    },
    scene,
    sceneId,
    text,
    timestamp: parseTimestamp(event.time),
    replyTarget: encodeReplyTarget(replyTarget),
    // OneBot 的 reply 段没有统一字段位置：数组格式在 message 里，这里只取 top-level 兜底
    replyToMessageId: idOf(event.reply_message_id),
    trust: 'untrusted',
    raw: {
      postType,
      messageType,
      // 只留审计需要的最小集：不保留原始 message / sender 全量（可能含 QQ 号、群名片）
      selfId,
      groupId: sceneId,
    },
  }
}
