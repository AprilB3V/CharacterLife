/**
 * 运行时装配：把持久层、身份服务、适配器、Gateway 组装成一个可运行实例。
 *
 * 服务器与示例脚本共用这一份装配逻辑，避免「示例能跑、服务器跑不起来」。
 */

import { TraceStore } from '../runtime/trace.ts'
import { DEFAULT_CONVERSATION_CONFIG } from '../conversation/service.ts'
import { DEFAULT_CONTEXT_BUDGET } from '../context/manager.ts'
import { DEFAULT_WILLINGNESS } from '../kernel/thinking/willingness.ts'
import { join } from 'node:path'
import type { CharacterTemplate } from '../character/template.ts'
import { defineTemplate } from '../character/template.ts'
import type { TemplateEventSpec } from '../character/template.ts'
import { CharacterDatabase } from '../persistence/database.ts'
import { CharacterPersistence } from '../persistence/store.ts'
import { PlatformStore } from '../persistence/platform-store.ts'
import { IdentityService } from '../identity/identity-service.ts'
import { InstanceRuntimeManager } from '../runtime/instance-runtime.ts'
import type { InstanceRuntimeDeps } from '../runtime/instance-runtime.ts'
import type { MemoryReviewMode } from '../runtime/memory-review.ts'
import { MessageGateway } from './gateway.ts'
import { QQAdapter } from '../adapters/qq/adapter.ts'
import { QQApiClient, FetchTransport } from '../adapters/qq/api-client.ts'
import type { QQTransport } from '../adapters/qq/api-client.ts'
import { OneBotAdapter } from '../adapters/onebot/adapter.ts'
import { OneBotApiClient, FetchTransport as OneBotFetchTransport } from '../adapters/onebot/api-client.ts'
import type { OneBotTransport } from '../adapters/onebot/api-client.ts'
import type { OneBotParseOptions } from '../adapters/onebot/events.ts'
import { SillyTavernAdapter } from '../adapters/sillytavern/adapter.ts'
import { TelegramAdapter } from '../adapters/telegram/adapter.ts'
import { TelegramApiClient, FetchTransport as TelegramFetchTransport } from '../adapters/telegram/api-client.ts'
import type { TelegramTransport } from '../adapters/telegram/api-client.ts'
import type { TelegramParseOptions } from '../adapters/telegram/events.ts'
import { ManualClock, SystemClock } from '../kernel/util/clock.ts'
import type { Clock } from '../kernel/util/clock.ts'
import { SeededRng } from '../kernel/util/rng.ts'
import { SequentialIdFactory } from '../kernel/util/ids.ts'
import { MockProvider } from '../conversation/providers/mock.ts'
import { DeepSeekProvider, deepSeekConfigFromEnv } from '../conversation/providers/deepseek.ts'
import { parseReasoningMode, reasoningBody } from '../conversation/providers/reasoning.ts'
import type { LLMProvider } from '../types.ts'
import { LlmThinker } from '../kernel/thinking/thinker.ts'
import type { WillingnessConfig } from '../kernel/thinking/willingness.ts'
import type { ContextBudget } from '../context/manager.ts'
import type { ConversationConfig } from '../conversation/service.ts'
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
    /** Accept external observations only when explicitly enabled by the deployment. */
    acceptObservations?: boolean
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
    configureInstance?: InstanceRuntimeDeps['configureInstance']
    /** Deployment-specific knowledge retrieval; absent deployments keep existing behavior. */
    referenceData?: (query: string) => string
    conversation?: Partial<ConversationConfig>
    /** Hold chat-model memory proposals for owner review ('model'); default writes immediately. */
    memoryReview?: MemoryReviewMode
  dbPath: string
  worldId: string
  /** 角色模板；不传则使用原创角色沈知微 */
  template?: CharacterTemplate
  provider?: LLMProvider
  /**
   * Model for the thinking loop (cheap and fast, strict JSON). Absent: `thinkProviderFromEnv()`;
   * when that is not configured either, thinking is off and `/v1/think` refuses.
   */
  thinkProvider?: LLMProvider | null
  /** Completion cap for thinking calls; 0 sends none. Default from CHARACTERLIFE_THINK_MAX_TOKENS, else 0. */
  thinkMaxTokens?: number
  willingness?: Partial<WillingnessConfig>
  thinkingLoop?: InstanceRuntimeDeps['thinkingLoop']
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
    /** Send each line of a reply as its own QQ message (default false) */
    splitReplies?: boolean
  }
  /** Telegram 机器人（Bot API 长轮询）。没有则完全不挂 Telegram 适配器。 */
  telegram?: {
    /** bot token；只在内存里使用，不落盘、不进日志 */
    token: string
    /** 自建反代或中转地址，默认 https://api.telegram.org */
    apiBase?: string
    transport?: TelegramTransport
    proactive?: boolean
    parse?: TelegramParseOptions
    splitParagraphs?: boolean
    /** 气泡间「正在输入」停顿的每字毫秒数；0 关闭（测试用） */
    typingMsPerChar?: number
  }
  bindTargetPlatform?: string
  /** Owner-console thought traces kept per instance in memory; 0 turns tracing off (default 100). */
  tracesPerInstance?: number
}

const SECRET_KEY = /key|token|secret|password|passwd|auth|credential|cookie|signature/i

/** Drop user info and secret-looking query values from a URL shown in the console. */
export function redactUrl(raw: string): string {
  try {
    const url = new URL(raw)
    if (url.username || url.password) { url.username = 'redacted'; url.password = '' }
    for (const key of [...url.searchParams.keys()]) if (SECRET_KEY.test(key)) url.searchParams.set(key, 'redacted')
    return url.toString()
  } catch {
    return raw
  }
}

/** Secret-free, JSON-safe copy of provider-reported settings: secret-looking keys hidden, URLs redacted. */
export function redactSettings(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? redactUrl(value) : value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()
  if (typeof value !== 'object' || depth > 6) return `［${typeof value}］`
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactSettings(item, depth + 1))
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SECRET_KEY.test(key) && !/tokens$/i.test(key) ? 'set' : redactSettings(item, depth + 1)]))
}

/**
 * What this process runs with, for the owner console. Built once at assembly from the resolved
 * config; secrets (API keys, tokens, app secrets) are reported only as present or absent.
 */
export interface RuntimeDescription {
  dbPath: string
  worldId: string
  provider: { name: string; model: string; note: string; settings: Record<string, unknown> }
  thinking: { name: string; model: string; maxTokens: number; settings: Record<string, unknown> } | null
  conversation: Record<string, unknown>
  contextBudget: Record<string, unknown>
  memoryReview: string
  willingness: Record<string, unknown>
  thinkingLoop: Record<string, unknown>
  world: Record<string, unknown> | null
  adapters: Record<string, Record<string, unknown>>
  bindTargetPlatform: string
  traces: { perInstance: number } | null
  template: {
    id: string
    version: number
    contentHash: string
    timelineEvents: number
    profile: unknown
    voice: unknown
  }
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
  telegramAdapter: TelegramAdapter | null
  sillyTavernAdapter: SillyTavernAdapter
  template: CharacterTemplate
  clock: Clock
  provider: LLMProvider
  /** Thinking loop model; null when thinking is off. */
  thinkProvider: LLMProvider | null
  /** Owner-console thought traces; null when tracing is off. */
  traces: TraceStore | null
  /** Resolved, secret-free configuration of this process. */
  describe(): RuntimeDescription
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
        extraBody: reasoningBody(deepseek.reasoning),
      }),
      note: `DeepSeek（请求 ${deepseek.model}，reasoning ${deepseek.reasoning}）`,
    }
  }
  return { provider: new MockProvider({ mode: 'in-character' }), note: 'MockProvider（未检测到 DEEPSEEK_API_KEY）' }
}

/**
 * Thinking model from the environment: any OpenAI-compatible endpoint.
 * CHARACTERLIFE_THINK_BASE_URL, CHARACTERLIFE_THINK_MODEL and CHARACTERLIFE_THINK_API_KEY must all be set.
 * CHARACTERLIFE_THINK_REASONING picks a reasoning mode (off = disabled | low | minimal | default, see reasoning.ts);
 * unset sends no reasoning field, as before, for endpoints that do not accept one.
 */
export function thinkProviderFromEnv(env: NodeJS.ProcessEnv = process.env): LLMProvider | null {
  const baseUrl = env.CHARACTERLIFE_THINK_BASE_URL?.trim()
  const model = env.CHARACTERLIFE_THINK_MODEL?.trim()
  const apiKey = env.CHARACTERLIFE_THINK_API_KEY?.trim()
  if (!baseUrl || !model || !apiKey) return null
  const reasoning = parseReasoningMode(env.CHARACTERLIFE_THINK_REASONING)
  return new DeepSeekProvider({ apiKey, baseUrl, model, timeoutMs: Number(env.CHARACTERLIFE_THINK_TIMEOUT_MS ?? 20000),
    ...(reasoning ? { extraBody: reasoningBody(reasoning) } : {}) })
}

/** Completion cap for the thinker: 0 (default) sends none, so a reasoning model never truncates the JSON. */
export function thinkMaxTokensFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.CHARACTERLIFE_THINK_MAX_TOKENS ?? 0)
  return Number.isFinite(value) && value > 0 ? value : 0
}

function describeProvider(provider: LLMProvider): Record<string, unknown> {
  try {
    return redactSettings(provider.describe?.() ?? {}) as Record<string, unknown>
  } catch {
    return { error: 'describe() failed' }
  }
}

export function assembleRuntime(config: RuntimeConfig): RuntimeBundle {
  const clock = config.clock ?? new SystemClock()
  const db = new CharacterDatabase(config.dbPath)
  const persistence = new CharacterPersistence(db)
  const platformStore = new PlatformStore(db)
  const ids = new SequentialIdFactory()
  const { provider, note } = chooseProvider(config.provider)
  const thinkProvider = config.thinkProvider === undefined ? thinkProviderFromEnv() : config.thinkProvider
  const template = config.template ?? defaultTemplate()
  const tracesPerInstance = config.tracesPerInstance ?? 100
  const traces = tracesPerInstance > 0 ? new TraceStore({ perInstance: tracesPerInstance }) : null
  const thinkMaxTokens = config.thinkMaxTokens ?? thinkMaxTokensFromEnv()

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
          acceptObservations: worldConfig.acceptObservations,
          allowedVerbs: worldConfig.allowedVerbs ?? ['use'],
          allowedTargets: worldConfig.allowedTargets ?? ['desk_01'],
          actionTtlSim: worldConfig.actionTtlMs,
          leaseTtlSim: worldConfig.leaseTtlMs,
          maxAttempts: worldConfig.maxAttempts,
          maxActionsPerSimHour: worldConfig.maxActionsPerSimHour,
        })
      : null

  const runtimeManager = new InstanceRuntimeManager({
    configureInstance: config.configureInstance,
    referenceData: config.referenceData,
    persistence,
    provider,
    clock,
    ids,
    rng: new SeededRng(20250104),
    auditFile: config.auditFile ?? null,
    budget: config.budget,
    conversation: config.conversation,
    memoryReview: config.memoryReview,
    probeQuery: '那本被水泡过的书',
    world,
    ...(thinkProvider ? { thinker: new LlmThinker({ provider: thinkProvider, maxTokens: thinkMaxTokens }) } : {}),
    ...(traces ? { traces } : {}),
    willingness: config.willingness,
    thinkingLoop: config.thinkingLoop,
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
      splitReplies: config.onebot.splitReplies === true,
    })
    gateway.registerAdapter(onebotAdapter)
  }

  let telegramAdapter: TelegramAdapter | null = null
  if (config.telegram) {
    const client = new TelegramApiClient({
      transport:
        config.telegram.transport ??
        new TelegramFetchTransport({ token: config.telegram.token, apiBase: config.telegram.apiBase }),
    })
    telegramAdapter = new TelegramAdapter({
      client,
      capabilities: { proactive: config.telegram.proactive !== false },
      parse: config.telegram.parse,
      splitParagraphs: config.telegram.splitParagraphs,
      typingMsPerChar: config.telegram.typingMsPerChar,
    })
    gateway.registerAdapter(telegramAdapter)
  }

  const description: RuntimeDescription = {
    dbPath: config.dbPath,
    worldId: config.worldId,
    provider: { name: provider.name, model: provider.model, note, settings: describeProvider(provider) },
    thinking: thinkProvider
      ? { name: thinkProvider.name, model: thinkProvider.model, maxTokens: thinkMaxTokens, settings: describeProvider(thinkProvider) }
      : null,
    conversation: structuredClone({ ...DEFAULT_CONVERSATION_CONFIG, ...config.conversation }) as unknown as Record<string, unknown>,
    contextBudget: { ...DEFAULT_CONTEXT_BUDGET, ...config.budget },
    memoryReview: config.memoryReview ?? 'off',
    willingness: { ...DEFAULT_WILLINGNESS, ...config.willingness },
    thinkingLoop: { maxChain: config.thinkingLoop?.maxChain ?? 3, holdMs: config.thinkingLoop?.holdMs ?? 1500 },
    world: world ? redactSettings({ ...config.world }) as Record<string, unknown> : null,
    adapters: {
      sillytavern: { enabled: true },
      ...(config.qq ? { qq: { appId: config.qq.appId, appSecret: 'set', proactive: config.qq.proactive === true } } : {}),
      ...(config.onebot ? { onebot: { baseUrl: redactUrl(config.onebot.baseUrl), accessToken: config.onebot.accessToken ? 'set' : 'none',
        proactive: config.onebot.proactive !== false, splitReplies: config.onebot.splitReplies === true,
        parse: structuredClone(config.onebot.parse ?? {}) } } : {}),
      ...(config.telegram ? { telegram: { token: 'set', apiBase: redactUrl(config.telegram.apiBase ?? 'https://api.telegram.org'),
        proactive: config.telegram.proactive !== false, parse: structuredClone(config.telegram.parse ?? {}),
        splitParagraphs: config.telegram.splitParagraphs ?? true } } : {}),
    },
    bindTargetPlatform: config.bindTargetPlatform ?? 'sillytavern',
    traces: traces ? { perInstance: traces.perInstance } : null,
    template: {
      id: template.id,
      version: template.version,
      contentHash: template.contentHash,
      timelineEvents: template.timeline.length,
      profile: structuredClone(template.profile),
      voice: structuredClone(template.voice),
    },
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
    telegramAdapter,
    sillyTavernAdapter,
    template,
    clock,
    provider,
    thinkProvider,
    traces,
    describe: () => structuredClone(description),
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
    /** Send each line of a reply as its own message (ONEBOT_SPLIT_REPLIES, default true) */
    splitReplies: boolean
    /** Wait this long (random in range) for follow-up messages before replying; null = reply at once */
    replyWait: { minMs: number; maxMs: number } | null
  } | null
  telegram: {
    token: string
    apiBase: string | undefined
    /** 原始 Telegram 用户 id 白名单；null 表示任何人（必须显式 TELEGRAM_ALLOW_ANYONE=true） */
    allowedUserIds: Set<string> | null
    proactive: boolean
    splitParagraphs: boolean
    parse: TelegramParseOptions
  } | null
}

/** "3000-5000" or "4000" in ms; "0" or invalid means reply at once (null). */
export function parseWaitRange(raw: string): { minMs: number; maxMs: number } | null {
  const [a, b] = raw.split('-').map((s) => Number(s.trim()))
  const minMs = a ?? NaN
  const maxMs = b ?? minMs
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs) || minMs < 0 || maxMs <= 0) return null
  return { minMs: Math.min(minMs, maxMs), maxMs: Math.max(minMs, maxMs) }
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
          splitReplies: env.ONEBOT_SPLIT_REPLIES !== 'false',
          replyWait: parseWaitRange(env.ONEBOT_REPLY_WAIT_MS ?? '3000-5000'),
          parse: {
            selfId: env.ONEBOT_SELF_ID ?? null,
            groupMentionOnly: env.ONEBOT_GROUP_MENTION_ONLY !== 'false',
            allowGroupCommands: env.ONEBOT_ALLOW_GROUP_COMMANDS !== 'false',
            anonymizeUserIds: env.ONEBOT_ANONYMIZE !== 'false',
            captureNickname: env.ONEBOT_CAPTURE_NICKNAME === 'true',
          },
        }
      : null,
    telegram: env.TELEGRAM_BOT_TOKEN
      ? {
          token: env.TELEGRAM_BOT_TOKEN,
          apiBase: env.TELEGRAM_API_BASE || undefined,
          allowedUserIds:
            env.TELEGRAM_ALLOW_ANYONE === 'true'
              ? null
              : new Set(
                  (env.TELEGRAM_ALLOWED_USER_IDS ?? '')
                    .split(',')
                    .map((s) => s.trim())
                    .filter((s) => /^\d+$/.test(s)),
                ),
          proactive: env.TELEGRAM_PROACTIVE !== 'false',
          splitParagraphs: env.TELEGRAM_SPLIT_PARAGRAPHS !== 'false',
          parse: {
            anonymizeUserIds: env.TELEGRAM_ANONYMIZE !== 'false',
            captureName: env.TELEGRAM_CAPTURE_NAME === 'true',
          },
        }
      : null,
  }
}

export const MANUAL_CLOCK_HINT = '测试与离线演示请显式传入 ManualClock，避免真实时间影响断言'
export { ManualClock }
