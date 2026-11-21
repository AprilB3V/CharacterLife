/**
 * Telegram Update → NormalizedMessage.
 *
 * 第一版只接私聊（chat.type = private）：陪伴场景以一对一为主，群聊的 @、隐私模式、
 * 多人记忆隔离都要另外设计，先不碰。群聊、频道、编辑消息、机器人发来的消息一律返回 null。
 *
 * 文本来源：message.text；图片/文件的说明文字 caption；贴纸只取它代表的 emoji。
 * 其余类型（语音、位置等）返回 null，不报错，避免平台新增类型把机器人打挂。
 */

import { createHash } from 'node:crypto'
import type { NormalizedMessage } from '../protocol.ts'
import { InboundParseError } from '../protocol.ts'

export const TELEGRAM_PLATFORM = 'telegram'

export interface TelegramParseOptions {
  /** 把 Telegram 用户 id 哈希成假名再落库（默认 true） */
  anonymizeUserIds?: boolean
  /** 是否把名字带进 displayName（默认 false：名字只用于展示，但也是个人信息） */
  captureName?: boolean
}

interface RawUser {
  id?: number
  is_bot?: boolean
  first_name?: string
  username?: string
}

interface RawMessage {
  message_id?: number
  date?: number
  chat?: { id?: number; type?: string }
  from?: RawUser
  text?: string
  caption?: string
  sticker?: { emoji?: string }
}

export interface TelegramReplyTarget {
  chatId: number
}

export function anonymizeTelegramUserId(userId: number | string): string {
  return `tg_${createHash('sha256').update(`telegram:${userId}`).digest('hex').slice(0, 16)}`
}

export function encodeReplyTarget(target: TelegramReplyTarget): string {
  return JSON.stringify(target)
}

export function decodeReplyTarget(raw: string): TelegramReplyTarget {
  try {
    const parsed = JSON.parse(raw) as TelegramReplyTarget
    if (typeof parsed.chatId === 'number' && Number.isSafeInteger(parsed.chatId)) return parsed
  } catch {
    /* fall through */
  }
  throw new InboundParseError(`非法 replyTarget: ${raw.slice(0, 80)}`)
}

/** 去掉 /cmd@BotName 里的 @BotName，让内核指令（/help、/status …）在 Telegram 里也能识别。 */
export function normalizeCommandText(text: string): string {
  return text.replace(/^(\/[A-Za-z0-9_]+)@[A-Za-z0-9_]+/, '$1')
}

/** 从 Update 里取出私聊消息本体；不是私聊消息时返回 null。供轮询器做预检（白名单、/start）。 */
export function extractPrivateMessage(raw: unknown): { message: RawMessage; userId: number; chatId: number } | null {
  if (!raw || typeof raw !== 'object') throw new InboundParseError('Update 不是对象')
  const update = raw as { message?: RawMessage }
  const message = update.message
  if (!message || typeof message !== 'object') return null
  if (message.chat?.type !== 'private') return null
  const userId = message.from?.id
  const chatId = message.chat.id
  if (typeof userId !== 'number' || typeof chatId !== 'number') {
    throw new InboundParseError('私聊消息缺少 from.id 或 chat.id')
  }
  if (message.from?.is_bot) return null
  return { message, userId, chatId }
}

export function messageText(message: RawMessage): string | null {
  if (typeof message.text === 'string') return normalizeCommandText(message.text).trim()
  if (typeof message.caption === 'string') return message.caption.trim()
  if (message.sticker && typeof message.sticker.emoji === 'string') return `（贴纸 ${message.sticker.emoji}）`
  return null
}

export function parseTelegramUpdate(raw: unknown, opts: TelegramParseOptions = {}): NormalizedMessage | null {
  const extracted = extractPrivateMessage(raw)
  if (!extracted) return null
  const { message, userId, chatId } = extracted
  if (typeof message.message_id !== 'number') throw new InboundParseError('消息缺少 message_id')
  const text = messageText(message)
  if (text === null || text.length === 0) return null

  const anonymize = opts.anonymizeUserIds !== false
  const platformUserId = anonymize ? anonymizeTelegramUserId(userId) : String(userId)
  const displayName =
    opts.captureName === true ? (message.from?.first_name ?? message.from?.username ?? undefined) : undefined

  return {
    platform: TELEGRAM_PLATFORM,
    // message_id is only unique within one chat
    platformMessageId: `${chatId}:${message.message_id}`,
    identity: { platform: TELEGRAM_PLATFORM, platformUserId, displayName },
    scene: 'c2c',
    sceneId: null,
    text,
    timestamp: typeof message.date === 'number' ? message.date * 1000 : Date.now(),
    replyTarget: encodeReplyTarget({ chatId }),
    replyToMessageId: null,
    trust: 'untrusted',
    raw: {
      updateId: (raw as { update_id?: number }).update_id ?? null,
      chatType: 'private',
    },
  }
}
