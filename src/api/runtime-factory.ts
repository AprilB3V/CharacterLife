/**
 * 运行时装配：把持久层、身份服务、适配器、Gateway 组装成一个可运行实例。
 *
 * 服务器与示例脚本共用这一份装配逻辑，避免「示例能跑、服务器跑不起来」。
 */

import { join } from 'node:path'
import type { CharacterTemplate } from '../character/template.ts'
import { defineTemplate } from '../character/template.ts'
import type { TemplateEventSpec } from '../character/template.ts'
import { CharacterDatabase } from '../persistence/database.ts'
import { CharacterPersistence } from '../persistence/store.ts'
import { PlatformStore } from '../persistence/platform-store.ts'
import { IdentityService } from '../identity/identity-service.ts'
import { InstanceRuntimeManager } from '../runtime/instance-runtime.ts'
import { MessageGateway } from './gateway.ts'
import { QQAdapter } from '../adapters/qq/adapter.ts'
import { QQApiClient, FetchTransport } from '../adapters/qq/api-client.ts'
import type { QQTransport } from '../adapters/qq/api-client.ts'
import { OneBotAdapter } from '../adapters/onebot/adapter.ts'
import { OneBotApiClient, FetchTransport as OneBotFetchTransport } from '../adapters/onebot/api-client.ts'
import type { OneBotTransport } from '../adapters/onebot/api-client.ts'
import type { OneBotParseOptions } from '../adapters/onebot/events.ts'
import { SillyTavernAdapter } from '../adapters/sillytavern/adapter.ts'
import { ManualClock, SystemClock } from '../kernel/util/clock.ts'
import type { Clock } from '../kernel/util/clock.ts'
import { SeededRng } from '../kernel/util/rng.ts'
import { SequentialIdFactory } from '../kernel/util/ids.ts'
import { MockProvider } from '../conversation/providers/mock.ts'
import { DeepSeekProvider, deepSeekConfigFromEnv } from '../conversation/providers/deepseek.ts'
import type { LLMProvider } from '../types.ts'
import type { ContextBudget } from '../context/manager.ts'
import { WorldService } from '../kernel/world/service.ts'
import { shenZhiweiProfile, shenZhiweiTimeline, shenZhiweiVoice } from '../../examples/characters/shen-zhiwei.ts'

/**
 * 世界交互配置（第一阶段）。
 *
 * 只有 `enabled === true` 且至少给了一个 `worldIds` 才会创建 WorldService；
 * 否则 `runtime.world === null`，HTTP 层不挂载任何 `/v1/world/*` 路由，
 * 既有启动路径的行为完全不变。
 */
export interface WorldRuntimeConfig {
  enabled?: boolean
  /** 授权世界白名单（服务端权威，token 之外的第二道校验） */
  worldIds?: string[]
  /** 动词白名单；缺省只允许 `use` */
  allowedVerbs?: string[]
  /** 目标白名单；缺省只允许 `desk_01` */
  allowedTargets?: string[]
  /** 动作从登记到被领取的最长等待（模拟时间毫秒，默认 90s） */
  actionTtlMs?: number
  /** 单次领取的租约时长（模拟时间毫秒，默认 30s） */
  leaseTtlMs?: number
  /** 最多领取次数（默认 2） */
  maxAttempts?: number
  /** 每实例每模拟小时准入上限（默认 120；第一阶段为联调放宽） */
  maxActionsPerSimHour?: number
}

export interface RuntimeConfig {
  dbPath: string
  worldId: string
  /** 角色模板；不传则使用原创角色沈知微 */
  template?: CharacterTemplate
  provider?: LLMProvider
  clock?: Clock
  budget?: Partial<ContextBudget>
  auditFile?: string | null
  /** 世界交互（第一阶段：内存动作队列，未启用则不挂载任何世界路由） */
  world?: WorldRuntimeConfig
  /** QQ 凭证（没有则只挂 Mock/不挂 QQ） */
  qq?: {
    appId: string
    appSecret: string
    transport?: QQTransport
    proactive?: boolean
  }
  /**
   * OneBot 11 网关（NapCat / Lagrange.OneBot / SnowLuma …）。
   * 没有则完全不挂 OneBot 适配器。
   */
  onebot?: {
    /** 网关 HTTP API 地址，例如 http://127.0.0.1:3000 */
    baseUrl: string
    /** 网关 access_token（可空） */
    accessToken?: string | null
    transport?: OneBotTransport
    proactive?: boolean
    parse?: OneBotParseOptions
  }
  bindTargetPlatform?: string
}

export interface RuntimeBundle {
  db: CharacterDatabase
  persistence: CharacterPersistence
  platformStore: PlatformStore
  identityService: IdentityService
  runtimeManager: InstanceRuntimeManager
  gateway: MessageGateway
  /** 世界交互服务；未启用时为 null（内存队列，重启即丢失） */
  world: WorldService | null
  qqAdapter: QQAdapter | null
  onebotAdapter: OneBotAdapter | null
  onebotClient: OneBotApiClient | null
  sillyTavernAdapter: SillyTavernAdapter
  template: CharacterTemplate
  clock: Clock
  provider: LLMProvider
  close(): void
}

export function defaultTemplate(): CharacterTemplate {
  const timeline: TemplateEventSpec[] = shenZhiweiTimeline().map((e) => ({
    id: e.id,
    atSim: e.atSim,
    kind: (e.id.startsWith('plot_') ? 'plot' : 'life') as TemplateEventSpec['kind'],
    title: e.title,
    description: e.description,
    payload: e.payload,
  }))
  return defineTemplate({
    version: 1,
    profile: shenZhiweiProfile,
    voice: shenZhiweiVoice,
    timeline,
    createdAtWall: '2025-01-04T09:00:00.000Z',
  })
}

export function chooseProvider(config?: LLMProvider): { provider: LLMProvider; note: string } {
  if (config) return { provider: config, note: '显式注入的 Provider' }
  const deepseek = deepSeekConfigFromEnv()
  if (deepseek) {
    return {
      provider: new DeepSeekProvider({
        apiKey: deepseek.apiKey,
        baseUrl: deepseek.baseUrl,
        model: deepseek.model,
      }),
      note: `DeepSeek（请求 ${deepseek.model}）`,
    }
  }
  return { provider: new MockProvider({ mode: 'in-character' }), note: 'MockProvider（未检测到 DEEPSEEK_API_KEY）' }
}

export function assembleRuntime(config: RuntimeConfig): RuntimeBundle {
  const clock = config.clock ?? new SystemClock()
  const db = new CharacterDatabase(config.dbPath)
  const persistence = new CharacterPersistence(db)
  const platformStore = new PlatformStore(db)
  const ids = new SequentialIdFactory()
  const { provider, note } = chooseProvider(config.provider)
  const template = config.template ?? defaultTemplate()

  // 模板入库（同 id+version 幂等），保证恢复时能校验哈希
  persistence.putTemplate(template)

  const identityService = new IdentityService({
    persistence,
    platformStore,
    template,
    worldId: config.worldId,
    ids,
    nowIso: () => new Date().toISOString(),
  })

  // 世界交互：只在显式启用且配置了世界白名单时创建。
  // 实例归属由持久层权威解析，任何调用方都无法自行指定 worldId。
  const worldConfig = config.world
  const world =
    worldConfig?.enabled === true && (worldConfig.worldIds?.length ?? 0) > 0
      ? new WorldService({
          clock,
          ids,
          lookupInstance: (instanceId) => {
            const instance = persistence.getInstance(instanceId)
            return instance ? { worldId: instance.worldId } : null
          },
          worldIds: worldConfig.worldIds,
          allowedVerbs: worldConfig.allowedVerbs ?? ['use'],
          allowedTargets: worldConfig.allowedTargets ?? ['desk_01'],
          actionTtlSim: worldConfig.actionTtlMs,
          leaseTtlSim: worldConfig.leaseTtlMs,
          maxAttempts: worldConfig.maxAttempts,
          maxActionsPerSimHour: worldConfig.maxActionsPerSimHour,
        })
      : null

  const runtimeManager = new InstanceRuntimeManager({
    persistence,
    provider,
    clock,
    ids,
    rng: new SeededRng(20250104),
    auditFile: config.auditFile ?? null,
    budget: config.budget,
    probeQuery: '那本被水泡过的书',
    world,
  })

  const gateway = new MessageGateway({
    platformStore,
    identityService,
    runtimeManager,
    clock,
    bindTargetPlatform: config.bindTargetPlatform ?? 'sillytavern',
  })

  const sillyTavernAdapter = new SillyTavernAdapter()
  gateway.registerAdapter(sillyTavernAdapter)

  let qqAdapter: QQAdapter | null = null
  if (config.qq) {
    const client = new QQApiClient({
      transport: config.qq.transport ?? new FetchTransport(),
      credentials: { appId: config.qq.appId, appSecret: config.qq.appSecret },
    })
    qqAdapter = new QQAdapter({
      client,
      capabilities: { proactive: config.qq.proactive === true },
    })
    gateway.registerAdapter(qqAdapter)
  }

  let onebotAdapter: OneBotAdapter | null = null
  let onebotClient: OneBotApiClient | null = null
  if (config.onebot) {
    onebotClient = new OneBotApiClient({
      transport: config.onebot.transport ?? new OneBotFetchTransport(),
      baseUrl: config.onebot.baseUrl,
      accessToken: config.onebot.accessToken ?? null,
    })
    onebotAdapter = new OneBotAdapter({
      client: onebotClient,
      capabilities: config.onebot.proactive === false ? { proactive: false } : { proactive: true },
      parse: config.onebot.parse,
    })
    gateway.registerAdapter(onebotAdapter)
  }

  return {
    db,
    persistence,
    platformStore,
    identityService,
    runtimeManager,
    gateway,
    world,
    qqAdapter,
    onebotAdapter,
    onebotClient,
    sillyTavernAdapter,
    template,
    clock,
    provider,
    close: () => db.close(),
    // 便于日志说明当前用的是哪个 provider
    ...({ providerNote: note } as Record<string, unknown>),
  } as RuntimeBundle
}

/** 从环境变量读配置（密钥只在内存中使用）。 */
export interface EnvConfig {
  dbPath: string
  token: string | null
  host: string
  port: number
  stIdentity: string
  deepseekModel: string
  qq: { appId: string; appSecret: string; proactive: boolean } | null
  /** 世界交互（缺省 null；只有 CLWORLD_ENABLED=true 才返回对象） */
  world: (WorldRuntimeConfig & { token: string | null; devMode: boolean }) | null
  onebot: {
    baseUrl: string
    accessToken: string | null
    secret: string | null
    host: string
    port: number
    path: string
    allowNonLoopback: boolean
    proactive: boolean
    parse: OneBotParseOptions
  } | null
}

export function loadEnvConfig(env: NodeJS.ProcessEnv = process.env): EnvConfig {
  const root = process.cwd()
  return {
    dbPath: env.CHARACTERLIFE_DB ?? join(root, 'data', 'characterlife.db'),
    token: env.CHARACTERLIFE_API_TOKEN ?? null,
    host: env.CHARACTERLIFE_HOST ?? '127.0.0.1',
    port: Number(env.CHARACTERLIFE_PORT ?? 8787),
    stIdentity: env.CHARACTERLIFE_ST_IDENTITY ?? 'local-default',
    deepseekModel: env.DEEPSEEK_MODEL ?? 'deepseek-chat',
    // 世界交互默认关闭：不设 CLWORLD_ENABLED=true 时整条链路不存在。
    world:
      env.CLWORLD_ENABLED === 'true'
        ? {
            enabled: true,
            token: env.CLWORLD_TOKEN ?? null,
            devMode: env.CLWORLD_DEV_MODE === 'true',
            worldIds: (env.CLWORLD_WORLD_IDS ?? '')
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0),
            allowedVerbs: (env.CLWORLD_ALLOWED_VERBS ?? 'use')
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0),
            allowedTargets: (env.CLWORLD_ALLOWED_TARGETS ?? 'desk_01')
              .split(',')
              .map((s) => s.trim())
              .filter((s) => s.length > 0),
            actionTtlMs: env.CLWORLD_ACTION_TTL_MS ? Number(env.CLWORLD_ACTION_TTL_MS) : undefined,
            leaseTtlMs: env.CLWORLD_LEASE_TTL_MS ? Number(env.CLWORLD_LEASE_TTL_MS) : undefined,
          }
        : null,
    qq:
      env.QQBOT_APP_ID && env.QQBOT_APP_SECRET
        ? {
            appId: env.QQBOT_APP_ID,
            appSecret: env.QQBOT_APP_SECRET,
            proactive: env.QQBOT_PROACTIVE === 'true',
          }
        : null,
    // OneBot 是「网关 + 本体」两段式：只有显式给了 API 地址才装配适配器
    onebot: env.ONEBOT_API_BASE
      ? {
          baseUrl: env.ONEBOT_API_BASE,
          accessToken: env.ONEBOT_ACCESS_TOKEN ?? null,
          secret: env.ONEBOT_SECRET ?? null,
          host: env.ONEBOT_HOST ?? '127.0.0.1',
          port: Number(env.ONEBOT_PORT ?? 8790),
          path: env.ONEBOT_PATH ?? '/onebot/event',
          allowNonLoopback: env.ONEBOT_ALLOW_PUBLIC === 'true',
          proactive: env.ONEBOT_PROACTIVE !== 'false',
          parse: {
            selfId: env.ONEBOT_SELF_ID ?? null,
            groupMentionOnly: env.ONEBOT_GROUP_MENTION_ONLY !== 'false',
            allowGroupCommands: env.ONEBOT_ALLOW_GROUP_COMMANDS !== 'false',
            anonymizeUserIds: env.ONEBOT_ANONYMIZE !== 'false',
            captureNickname: env.ONEBOT_CAPTURE_NICKNAME === 'true',
          },
        }
      : null,
  }
}

export const MANUAL_CLOCK_HINT = '测试与离线演示请显式传入 ManualClock，避免真实时间影响断言'
export { ManualClock }
