/**
 * 身份与绑定（P2 核心验收目标）。
 *
 * 三条硬规则：
 * 1. **不根据昵称推断跨平台是同一个人** —— 绑定只能通过一次性验证码完成；
 * 2. 一个平台身份只能指向一个实例；改绑必须先解绑（防止记忆串号）；
 * 3. 验证码短时、一次性、限制尝试次数；库里只存哈希。
 */

import { createHash, randomInt } from 'node:crypto'
import type { CharacterTemplate } from '../character/template.ts'
import type { CharacterInstance } from '../character/instance.ts'
import type { CharacterPersistence } from '../persistence/store.ts'
import type { PlatformStore, RedeemFailure } from '../persistence/platform-store.ts'
import type { PlatformBinding } from '../adapters/protocol.ts'
import type { IdFactory } from '../util/ids.ts'
import type { TimelineEvent } from '../types.ts'
import { createInitialDynamicState, createInitialRelationship } from '../runtime/state.ts'

export interface IdentityServiceOptions {
  persistence: CharacterPersistence
  platformStore: PlatformStore
  /** 新平台身份首次接触时创建实例所用的模板 */
  template: CharacterTemplate
  worldId: string
  ids: IdFactory
  nowIso: () => string
}

export interface ResolvedIdentity {
  binding: PlatformBinding
  instance: CharacterInstance
  created: boolean
}

export type BindError = RedeemFailure | 'MISSING_INSTANCE' | 'SELF_BIND' | 'ALREADY_BOUND'

export interface BindCodeResult {
  code: string
  expiresAt: string
  instanceId: string
}

/** 8 位数字验证码：易在聊天里输入，但只存哈希且一次性。 */
function generateCode(): string {
  return String(randomInt(0, 100_000_000)).padStart(8, '0')
}

export function hashCode(code: string): string {
  return createHash('sha256').update(`characterlife:${code.trim()}`).digest('hex')
}

export class IdentityService {
  #persistence: CharacterPersistence
  #platformStore: PlatformStore
  #template: CharacterTemplate
  #worldId: string
  #ids: IdFactory
  #nowIso: () => string
  /** 绑定码有效期（默认 5 分钟） */
  readonly codeTtlMs: number
  /** 单个验证码最多尝试次数 */
  readonly maxAttempts: number

  constructor(opts: IdentityServiceOptions & { codeTtlMs?: number; maxAttempts?: number }) {
    this.#persistence = opts.persistence
    this.#platformStore = opts.platformStore
    this.#template = opts.template
    this.#worldId = opts.worldId
    this.#ids = opts.ids
    this.#nowIso = opts.nowIso
    this.codeTtlMs = opts.codeTtlMs ?? 5 * 60 * 1000
    this.maxAttempts = opts.maxAttempts ?? 3
  }

  /** 查找身份对应的实例；首次接触时自动创建（该平台成为 primary）。 */
  resolveOrCreate(platform: string, platformUserId: string, displayName?: string): ResolvedIdentity {
    const existing = this.#platformStore.getBinding(platform, platformUserId)
    if (existing) {
      this.#platformStore.touch(platform, platformUserId, this.#nowIso())
      const instance = this.#persistence.requireInstance(existing.instanceId)
      return { binding: existing, instance, created: false }
    }
    const instanceId = this.#ids.next('inst')
    const instance = this.#persistence.createInstance(
      {
        id: instanceId,
        template: this.#template,
        playerId: `${platform}:${platformUserId}`,
        worldId: this.#worldId,
        label: `${this.#template.profile.name} · ${platform}`,
      },
      instanceId,
      this.#nowIso(),
    )
    const binding = this.#platformStore.bind({
      platform,
      platformUserId,
      instanceId: instance.id,
      displayName: displayName ?? null,
      source: 'primary',
      nowIso: this.#nowIso(),
    })
    this.#seedInitialState(instance.id)
    return { binding, instance, created: true }
  }

  /**
   * 新建实例时写入初始状态 + 模板时间线。
   *
   * 没有这一步，平台侧创建的角色就没有「自己的生活和剧情事件」，
   * 时间推进只会推进空时间线 —— 这是 V0.2 接入层必须补的一环。
   */
  #seedInitialState(instanceId: string): void {
    const template = this.#template
    const timeline: TimelineEvent[] = template.timeline.map((spec, index) => ({
      id: this.#ids.next('evt'),
      kind: spec.kind,
      atSim: spec.atSim,
      order: 100 + index,
      title: spec.title,
      description: spec.description,
      fired: false,
      firedAtSim: null,
      payload: { ...spec.payload },
    }))
    this.#persistence.saveState(instanceId, {
      relationship: createInitialRelationship(template.profile),
      dynamic: createInitialDynamicState(template.profile, 0),
      timeline,
      runtime: {},
      lastEventSeq: 0,
      savedAtSim: 0,
      savedAtWall: this.#nowIso(),
    })
  }

  /** 为某个实例签发一次性绑定码（必须已持有该实例的合法身份）。 */
  issueBindCode(opts: {
    instanceId: string
    targetPlatform: string
    createdBy: string
  }): BindCodeResult {
    this.#persistence.requireInstance(opts.instanceId)
    const code = generateCode()
    const record = this.#platformStore.createBindingCode({
      codeHash: hashCode(code),
      instanceId: opts.instanceId,
      targetPlatform: opts.targetPlatform,
      ttlMs: this.codeTtlMs,
      maxAttempts: this.maxAttempts,
      createdBy: opts.createdBy,
      nowIso: this.#nowIso(),
    })
    return { code, expiresAt: record.expiresAt, instanceId: record.instanceId }
  }

  /** 用验证码把另一个平台身份绑定到已有实例。 */
  redeemBindCode(opts: {
    code: string
    platform: string
    platformUserId: string
    displayName?: string
  }): { ok: boolean; instanceId: string | null; error: BindError | null } {
    const existing = this.#platformStore.getBinding(opts.platform, opts.platformUserId)
    const result = this.#platformStore.redeemBindingCode({
      codeHash: hashCode(opts.code),
      platform: opts.platform,
      maxAttemptsCap: this.maxAttempts,
      nowIso: this.#nowIso(),
    })
    if (!result.ok || !result.instanceId) {
      return { ok: false, instanceId: null, error: result.failure }
    }
    // 该身份已经绑到别的实例：拒绝（避免把 A 的记忆接到 B 上）
    if (existing && existing.instanceId !== result.instanceId) {
      return { ok: false, instanceId: null, error: 'ALREADY_BOUND' }
    }
    this.#persistence.requireInstance(result.instanceId)
    this.#platformStore.bind({
      platform: opts.platform,
      platformUserId: opts.platformUserId,
      instanceId: result.instanceId,
      displayName: opts.displayName ?? null,
      source: 'code',
      nowIso: this.#nowIso(),
    })
    return { ok: true, instanceId: result.instanceId, error: null }
  }

  unbind(platform: string, platformUserId: string): boolean {
    return this.#platformStore.unbind(platform, platformUserId)
  }

  listBindings(instanceId: string): PlatformBinding[] {
    return this.#platformStore.listBindings(instanceId)
  }

  /** 某个「玩家」是否只能看到自己的实例：用于测试记忆隔离。 */
  instanceFor(platform: string, platformUserId: string): string | null {
    return this.#platformStore.getBinding(platform, platformUserId)?.instanceId ?? null
  }
}
