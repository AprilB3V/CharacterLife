/**
 * Platform Adapter 协议 —— 平台接入层与角色引擎之间唯一的契约。
 *
 * 数据流（单向，平台永远不碰数据库）：
 *
 *   外部平台 → PlatformAdapter.parseInbound() → NormalizedMessage
 *            → MessageGateway（去重 / 身份 / 限流 / 会话）
 *            → ConversationService（角色引擎）
 *            → PlatformAdapter.send() → 外部平台
 *
 * 设计约束（对应任务书第三节）：
 * - 平台 SDK 逻辑只在 adapter 内部，核心引擎 import 不到任何平台代码；
 * - 所有入站内容一律视为不可信数据（NormalizedMessage.trust = 'untrusted'）；
 * - 适配器只做「翻译 + 传输」，不做身份判定、不写库、不决定人格。
 */

/** 支持的场景类型；不同平台共享同一套语义。 */
export type SceneKind = 'c2c' | 'group' | 'guild' | 'dm' | 'local'

export interface PlatformIdentity {
  platform: string
  /** 平台侧用户标识（QQ 是 openid，SillyTavern 是本地用户/会话标识） */
  platformUserId: string
  /** 仅用于展示，不作身份判定依据 */
  displayName?: string
}

/**
 * 平台适配器能力声明。
 *
 * 关键原则：**SDK 有接口 ≠ 账号有权限**。这里的值由适配器按「已核实的能力」显式声明，
 * 默认保守（主动消息 = false，回复窗口 = 0 表示未知/无限制）。
 */
export interface PlatformCapabilities {
  /** 是否能向该场景主动推送消息（不受入站消息触发） */
  proactive: boolean
  /** 被动回复窗口（毫秒）；0 表示平台未声明或不限制 */
  replyWindowMs: number
  /** 同一条入站消息允许的最大回复条数；0 表示不限制 */
  maxRepliesPerMessage: number
  /** 是否支持流式输出 */
  streaming: boolean
  /** 是否要求 Webhook 签名校验 */
  webhookSignature: boolean
}

/** 统一入站消息。所有字段都来自外部，故整体按不可信数据处理。 */
export interface NormalizedMessage {
  platform: string
  /** 平台消息唯一 id，用于去重 */
  platformMessageId: string
  identity: PlatformIdentity
  scene: SceneKind
  /** 场景对应的频道/群 id（c2c 为空） */
  sceneId: string | null
  text: string
  /** 平台时间戳（毫秒） */
  timestamp: number
  /** 回复目标：适配器自己解释的不透明字符串 */
  replyTarget: string
  /** 被回复/引用的消息 id（如果有） */
  replyToMessageId: string | null
  /** 信任级别：外站输入永远是 untrusted */
  trust: 'untrusted'
  /** 原始事件（不含密钥），便于审计与调试 */
  raw: Record<string, unknown>
}

/** 平台绑定：一个平台身份 → 一个角色实例。 */
export interface PlatformBinding {
  platform: string
  platformUserId: string
  instanceId: string
  displayName: string | null
  /** 首次建立方式：primary（该平台首次接触）/ code（一次性验证码）/ admin（手工） */
  source: 'primary' | 'code' | 'admin'
  createdAtWall: string
  lastSeenAtWall: string
}

export interface DeliveryError {
  code: 'NO_PERMISSION' | 'WINDOW_EXPIRED' | 'RATE_LIMITED' | 'PLATFORM_ERROR' | 'NOT_SUPPORTED'
  message: string
  retryable: boolean
}

export interface MessageDeliveryResult {
  ok: boolean
  /** 平台侧消息 id（如果平台返回） */
  platformMessageId: string | null
  /** 被适配器暂存而不是发送的原因（例如主动消息不可用） */
  queued: boolean
  error: DeliveryError | null
  latencyMs: number
}

export interface OutboundMessage {
  platform: string
  identity: PlatformIdentity
  scene: SceneKind
  sceneId: string | null
  replyTarget: string
  /** 被动回复必须带上的关联消息 id（QQ 要求） */
  replyToMessageId: string | null
  text: string
  /** true 表示这是角色主动发起（不受入站触发） */
  proactive: boolean
  /** 触发本次回复的入站消息时间戳（用于被动回复窗口检查） */
  inboundAt?: number
}

export interface PlatformAdapter {
  readonly platform: string
  readonly capabilities: PlatformCapabilities
  /**
   * 解析平台原始事件。
   * 返回 null 表示「不是需要处理的消息事件」；抛 InboundParseError 表示格式非法。
   */
  parseInbound(raw: unknown): NormalizedMessage | null
  /** 发送一条消息；失败必须返回结构化错误，不能抛到引擎里 */
  send(message: OutboundMessage): Promise<MessageDeliveryResult>
}

export class InboundParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InboundParseError'
  }
}

export function isNormalizedMessage(value: unknown): value is NormalizedMessage {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return (
    typeof v.platform === 'string' &&
    typeof v.platformMessageId === 'string' &&
    typeof v.text === 'string' &&
    typeof v.replyTarget === 'string' &&
    typeof v.identity === 'object' &&
    v.identity !== null
  )
}
