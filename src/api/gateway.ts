/**
 * CharacterLife API Gateway —— 平台消息的统一入口。
 *
 * 所有外部消息都必须经过这里，平台适配器拿不到数据库，也拿不到 workspace。
 *
 * 负责（按顺序）：
 *   1. 协议解析（交给 adapter）
 *   2. 幂等去重（platform + message_id 唯一）
 *   3. 每身份限流
 *   4. 身份 → 角色实例（首次接触自动创建）
 *   5. 每实例互斥锁（多平台并发不会互相覆盖状态）
 *   6. 指令拦截（不走模型）
 *   7. 待发送的主动消息作为「资料」并入下一轮，或按能力主动推送
 *   8. 调用角色引擎，持久化快照，再交回 adapter 发送
 */

import type {
  MessageDeliveryResult,
  NormalizedMessage,
  OutboundMessage,
  PlatformAdapter,
  PlatformIdentity,
} from '../adapters/protocol.ts'
import type { PlatformStore } from '../persistence/platform-store.ts'
import type { IdentityService } from '../identity/identity-service.ts'
import type { InstanceRuntimeManager } from '../runtime/instance-runtime.ts'
import type { Clock } from '../kernel/util/clock.ts'
import { handleCommand } from './commands.ts'

export type InboundStatus =
  | 'replied'
  | 'command'
  | 'ignored'
  | 'duplicate'
  | 'rejected'
  | 'rate_limited'
  | 'delivery_failed'

export interface InboundOutcome {
  status: InboundStatus
  platform: string
  platformMessageId: string | null
  instanceId: string | null
  sessionId: string | null
  reply: string | null
  delivery: MessageDeliveryResult | null
  reason: string | null
  /** 本轮实际 token 用量（来自 Provider），OpenAI 兼容层会透传 */
  usage: { promptTokens: number; completionTokens: number } | null
}

export interface GatewayOptions {
  platformStore: PlatformStore
  identityService: IdentityService
  runtimeManager: InstanceRuntimeManager
  clock: Clock
  /** 每个身份在窗口内的最大消息数（默认 20 / 60s） */
  rateLimit?: { windowMs?: number; maxPerWindow?: number }
  /** 一轮对话最多并入多少条未发出的主动消息（默认 3） */
  maxNotices?: number
  nowIso?: () => string
  /** 绑定码目标平台名（默认 sillytavern） */
  bindTargetPlatform?: string
}

class FixedWindowLimiter {
  #windowMs: number
  #max: number
  #buckets = new Map<string, { count: number; resetAt: number }>()

  constructor(windowMs: number, max: number) {
    this.#windowMs = windowMs
    this.#max = max
  }

  check(key: string, now: number): { allowed: boolean; retryAfterMs: number } {
    const bucket = this.#buckets.get(key)
    if (!bucket || now >= bucket.resetAt) {
      this.#buckets.set(key, { count: 1, resetAt: now + this.#windowMs })
      if (this.#buckets.size > 2000) {
        // 简单清理，避免无限增长
        for (const [k, v] of this.#buckets) if (now >= v.resetAt) this.#buckets.delete(k)
      }
      return { allowed: true, retryAfterMs: 0 }
    }
    if (bucket.count >= this.#max) {
      return { allowed: false, retryAfterMs: Math.max(0, bucket.resetAt - now) }
    }
    bucket.count++
    return { allowed: true, retryAfterMs: 0 }
  }
}

export function identityKey(identity: PlatformIdentity): string {
  return `${identity.platform}:${identity.platformUserId}`
}

export class MessageGateway {
  #adapters = new Map<string, PlatformAdapter>()
  #opts: GatewayOptions
  #limiter: FixedWindowLimiter

  constructor(opts: GatewayOptions) {
    this.#opts = opts
    this.#limiter = new FixedWindowLimiter(opts.rateLimit?.windowMs ?? 60_000, opts.rateLimit?.maxPerWindow ?? 20)
  }

  registerAdapter(adapter: PlatformAdapter): void {
    this.#adapters.set(adapter.platform, adapter)
  }

  adapter(platform: string): PlatformAdapter | null {
    return this.#adapters.get(platform) ?? null
  }

  /** 从平台原始事件进入。 */
  async handleRaw(platform: string, raw: unknown): Promise<InboundOutcome> {
    const adapter = this.#adapters.get(platform)
    if (!adapter) return this.#reject(platform, null, 'NO_ADAPTER', null)
    let message: NormalizedMessage | null
    try {
      message = adapter.parseInbound(raw)
    } catch (err) {
      return this.#reject(platform, null, `PARSE_ERROR: ${(err as Error).message}`, null)
    }
    if (!message) {
      return {
        status: 'ignored',
        platform,
        platformMessageId: null,
        instanceId: null,
        sessionId: null,
        reply: null,
        delivery: null,
        reason: 'NOT_A_MESSAGE_EVENT',
        usage: null,
      }
    }
    return this.handleMessage(adapter, message)
  }

  async handleMessage(
    adapter: PlatformAdapter,
    message: NormalizedMessage,
    extraNotices: string[] = [],
  ): Promise<InboundOutcome> {
    const { platformStore, identityService, runtimeManager, clock } = this.#opts
    const nowIso = (this.#opts.nowIso ?? (() => clock.nowWall().toISOString()))()
    const key = identityKey(message.identity)

    // 1) 幂等：同一条平台消息只处理一次
    const first = platformStore.markProcessed({
      platform: message.platform,
      platformMessageId: message.platformMessageId,
      instanceId: null,
      status: 'processing',
      nowIso,
    })
    if (!first) {
      return {
        status: 'duplicate',
        platform: message.platform,
        platformMessageId: message.platformMessageId,
        instanceId: null,
        sessionId: null,
        reply: null,
        delivery: null,
        reason: 'ALREADY_PROCESSED',
        usage: null,
      }
    }

    // 2) 限流（按平台身份，而不是全局）
    const limit = this.#limiter.check(key, Date.now())
    if (!limit.allowed) {
      platformStore.updateProcessedStatus(message.platform, message.platformMessageId, 'rate_limited')
      return {
        status: 'rate_limited',
        platform: message.platform,
        platformMessageId: message.platformMessageId,
        instanceId: null,
        sessionId: null,
        reply: null,
        delivery: null,
        reason: `RATE_LIMITED: retry after ${limit.retryAfterMs}ms`,
        usage: null,
      }
    }

    // 3) 身份 → 实例
    const resolved = identityService.resolveOrCreate(
      message.platform,
      message.identity.platformUserId,
      message.identity.displayName,
    )
    const instanceId = resolved.instance.id

    const runtime = runtimeManager.get(instanceId)

    // 4) 每实例互斥：同一实例的多平台消息串行化
    const outcome = await runtimeManager.withLock(instanceId, async () => {
      const sessionId = runtimeManager.ensureSession(runtime, key)
      const quiet = platformStore.isQuiet(message.platform, message.identity.platformUserId)

      // 4.1 指令
      const command = handleCommand(message.text, {
        runtime,
        instanceId,
        identity: message.identity,
        identityKey: key,
        sessionId,
        runtimeManager,
        platformStore,
        identityService,
        nowIso: () => nowIso,
        bindTargetPlatform: this.#opts.bindTargetPlatform,
      })
      if (command.handled) {
        const outbound = this.#outbound(message, command.text)
        const delivery = await this.#deliver(adapter, outbound)
        runtimeManager.saveSnapshot(runtime)
        return { reply: command.text, sessionId, delivery, status: 'command' as InboundStatus }
      }

      // 4.2 未能发出的主动消息：可用则主动推送一条，否则并入本轮作为资料
      const notices: string[] = []
      if (!quiet) {
        const pending = runtime.workspace.pendingMessages()
        if (pending.length > 0) {
          if (adapter.capabilities.proactive) {
            const [first] = runtime.workspace.drainPendingMessages()
            if (first) {
              await adapter.send({
                platform: message.platform,
                identity: message.identity,
                scene: message.scene,
                sceneId: message.sceneId,
                replyTarget: message.replyTarget,
                replyToMessageId: null,
                text: first.content,
                proactive: true,
              })
            }
          } else {
            const take = pending.slice(0, this.#opts.maxNotices ?? 3)
            for (const m of take) notices.push(m.content)
            runtime.workspace.drainPendingMessages()
          }
        }
      }

      // 4.3 调角色引擎
      const result = await runtimeManager.send(runtime, {
        identityKey: key,
        text: message.text,
        notices: [...extraNotices, ...notices],
      })
      runtimeManager.saveSnapshot(runtime)

      // 4.4 发送回复
      const outbound = this.#outbound(message, result.reply)
      const delivery = await this.#deliver(adapter, outbound)
      if (delivery.queued) {
        runtime.workspace.queueProactive('boundary_pushback', result.reply)
      }
      return {
        reply: result.reply,
        sessionId,
        delivery,
        status: 'replied' as InboundStatus,
        usage: result.usage ?? null,
      }
    })

    const status: InboundStatus =
      outcome.status === 'command' ? 'command' : outcome.delivery && !outcome.delivery.ok && !outcome.delivery.queued
        ? 'delivery_failed'
        : 'replied'
    platformStore.updateProcessedStatus(message.platform, message.platformMessageId, status)

    return {
      status,
      platform: message.platform,
      platformMessageId: message.platformMessageId,
      instanceId,
      sessionId: outcome.sessionId,
      reply: outcome.reply,
      delivery: outcome.delivery,
      reason: outcome.delivery?.error?.code ?? null,
      usage: outcome.usage ?? null,
    }
  }

  /** 主动推送（仅当适配器声明具备该能力）。 */
  async deliverProactive(
    platform: string,
    identity: PlatformIdentity,
    scene: OutboundMessage['scene'],
    sceneId: string | null,
    replyTarget: string,
    text: string,
  ): Promise<MessageDeliveryResult> {
    const adapter = this.#adapters.get(platform)
    const started = this.#opts.clock.nowSim()
    if (!adapter) {
      return {
        ok: false,
        platformMessageId: null,
        queued: true,
        error: { code: 'NOT_SUPPORTED', message: '没有该平台适配器', retryable: false },
        latencyMs: 0,
      }
    }
    if (!adapter.capabilities.proactive) {
      return {
        ok: false,
        platformMessageId: null,
        queued: true,
        error: { code: 'NOT_SUPPORTED', message: '平台未声明主动消息能力', retryable: false },
        latencyMs: this.#opts.clock.nowSim() - started,
      }
    }
    return adapter.send({
      platform,
      identity,
      scene,
      sceneId,
      replyTarget,
      replyToMessageId: null,
      text,
      proactive: true,
    })
  }

  #outbound(message: NormalizedMessage, text: string): OutboundMessage {
    return {
      platform: message.platform,
      identity: message.identity,
      scene: message.scene,
      sceneId: message.sceneId,
      replyTarget: message.replyTarget,
      replyToMessageId: message.platformMessageId,
      text,
      proactive: false,
      inboundAt: message.timestamp,
    }
  }

  /** 发送失败的可重试错误重试一次；限流不重试（避免加剧限流）。 */
  async #deliver(adapter: PlatformAdapter, outbound: OutboundMessage): Promise<MessageDeliveryResult> {
    const first = await adapter.send(outbound)
    if (first.ok || first.queued) return first
    const code = first.error?.code
    if (!first.error?.retryable || code === 'RATE_LIMITED') return first
    await new Promise((resolve) => setTimeout(resolve, 150))
    const second = await adapter.send(outbound)
    return { ...second, latencyMs: first.latencyMs + second.latencyMs }
  }

  #reject(platform: string, messageId: string | null, reason: string, instanceId: string | null): InboundOutcome {
    return {
      status: 'rejected',
      platform,
      platformMessageId: messageId,
      instanceId,
      sessionId: null,
      reply: null,
      delivery: null,
      reason,
      usage: null,
    }
  }
}
