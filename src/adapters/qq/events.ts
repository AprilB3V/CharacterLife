/**
 * QQ 官方机器人事件 → NormalizedMessage。
 *
 * 事件字段以 QQ 开放平台 v2 API 为准（SDK `@tencent-connect/qqbot-nodejs` 的
 * `InboundMessage` 也是从这些事件派生的）。这里只做协议转换，不依赖 SDK，
 * 好处是离线可测、且平台 SDK 升级不会污染核心引擎。
 *
 * 已支持的事件：
 * - C2C_MESSAGE_CREATE          单聊（QQ 消息列表）
 * - GROUP_AT_MESSAGE_CREATE     群聊 @机器人
 * - AT_MESSAGE_CREATE           QQ 频道 @机器人
 * - DIRECT_MESSAGE_CREATE       频道私信
 *
 * 未知事件一律返回 null（不报错），避免平台新增事件把机器人打挂。
 */

import type { NormalizedMessage, SceneKind } from '../protocol.ts'
import { InboundParseError } from '../protocol.ts'

interface RawEvent {
  id?: string
  op?: number
  t?: string
  d?: Record<string, unknown>
}

interface RawAuthor {
  id?: string
  user_openid?: string
  member_openid?: string
  union_openid?: string
  username?: string
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function parseTimestamp(value: unknown): number {
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (!Number.isNaN(parsed)) return parsed
  }
  return Date.now()
}

/** 去掉 @机器人 / 表情占位等噪声，只保留用户真正说的话。 */
export function sanitizeQQContent(content: string): string {
  return content
    .replace(/<@!?\d+>/g, '')
    .replace(/<@[^>]{1,64}>/g, '')
    .replace(/<faceType=\d+[^>]*>/g, '')
    .replace(/<emoji:\d+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export interface QQReplyTarget {
  scene: SceneKind
  /** c2c: user openid；group: group_openid；guild/dm: channel_id */
  target: string
  /** 频道场景需要 guild_id */
  guildId?: string
}

export function encodeReplyTarget(target: QQReplyTarget): string {
  return JSON.stringify(target)
}

export function decodeReplyTarget(raw: string): QQReplyTarget {
  try {
    const parsed = JSON.parse(raw) as QQReplyTarget
    if (typeof parsed.target === 'string' && typeof parsed.scene === 'string') return parsed
  } catch {
    /* 落到下面统一报错 */
  }
  throw new InboundParseError(`非法 replyTarget: ${raw.slice(0, 80)}`)
}

/** 解析一条平台事件；不是消息事件时返回 null。 */
export function parseQQEvent(raw: unknown): NormalizedMessage | null {
  if (!raw || typeof raw !== 'object') throw new InboundParseError('事件不是对象')
  const event = raw as RawEvent
  const type = event.t
  const data = event.d
  if (!type || !data) return null

  const sceneMap: Record<string, SceneKind> = {
    C2C_MESSAGE_CREATE: 'c2c',
    GROUP_AT_MESSAGE_CREATE: 'group',
    AT_MESSAGE_CREATE: 'guild',
    DIRECT_MESSAGE_CREATE: 'dm',
  }
  const scene = sceneMap[type]
  if (!scene) return null

  const author = (data.author ?? {}) as RawAuthor
  const messageId = asString(data.id)
  if (!messageId) throw new InboundParseError(`${type} 缺少 d.id`)

  let platformUserId: string | null = null
  let sceneId: string | null = null
  let replyTarget: QQReplyTarget

  if (scene === 'c2c') {
    platformUserId = asString(author.user_openid) ?? asString(author.id)
    replyTarget = { scene, target: platformUserId ?? '' }
  } else if (scene === 'group') {
    platformUserId = asString(author.member_openid) ?? asString(author.id)
    sceneId = asString(data.group_openid)
    replyTarget = { scene, target: sceneId ?? '' }
  } else {
    // guild / dm 都走频道消息接口，用 channel_id 作为发送目标
    platformUserId = asString(author.id)
    sceneId = asString(data.channel_id)
    const guildId = asString(data.guild_id) ?? undefined
    replyTarget = { scene, target: sceneId ?? '', guildId }
  }

  if (!platformUserId) throw new InboundParseError(`${type} 缺少作者标识`)
  if (!replyTarget.target) throw new InboundParseError(`${type} 缺少发送目标（openid/channel_id）`)

  const content = typeof data.content === 'string' ? data.content : ''
  const replyTo = asString(data.reply_to_message_id) ?? asString(data.msg_id) ?? null

  return {
    platform: 'qq',
    platformMessageId: messageId,
    identity: {
      platform: 'qq',
      platformUserId,
      displayName: asString(author.username) ?? undefined,
    },
    scene,
    sceneId,
    text: sanitizeQQContent(content),
    timestamp: parseTimestamp(data.timestamp),
    replyTarget: encodeReplyTarget(replyTarget),
    replyToMessageId: replyTo,
    trust: 'untrusted',
    raw: {
      eventId: event.id ?? null,
      eventType: type,
      sceneId,
      // 不保留原始 content 之外的敏感字段（如 token），只留审计需要的最小集
    },
  }
}
