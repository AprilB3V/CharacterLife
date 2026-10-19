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
import { MessageGateway } from '../api/gateway.ts'
import { QQAdapter } from '../adapters/qq/adapter.ts'
import { QQApiClient, FetchTransport } from '../adapters/qq/api-client.ts'
import type { QQTransport } from '../adapters/qq/api-client.ts'
import { SillyTavernAdapter } from '../adapters/sillytavern/adapter.ts'
import { ManualClock, SystemClock } from '../util/clock.ts'
import type { Clock } from '../util/clock.ts'
import { SeededRng } from '../util/rng.ts'
import { SequentialIdFactory } from '../util/ids.ts'
import { MockProvider } from '../conversation/providers/mock.ts'
import { DeepSeekProvider, deepSeekConfigFromEnv } from '../conversation/providers/deepseek.ts'
import type { LLMProvider } from '../types.ts'
import type { ContextBudget } from '../context/manager.ts'
import { shenZhiweiProfile, shenZhiweiTimeline, shenZhiweiVoice } from '../../examples/characters/shen-zhiwei.ts'

export interface RuntimeConfig {
  dbPath: string
  worldId: string
  /** 角色模板；不传则使用原创角色沈知微 */
  template?: CharacterTemplate
  provider?: LLMProvider
  clock?: Clock
  budget?: Partial<ContextBudget>
  auditFile?: string | null
  /** QQ 凭证（没有则只挂 Mock/不挂 QQ） */
  qq?: {
    appId: string
    appSecret: string
    transport?: QQTransport
    proactive?: boolean
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
  qqAdapter: QQAdapter | null
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

  const runtimeManager = new InstanceRuntimeManager({
    persistence,
    provider,
    clock,
    ids,
    rng: new SeededRng(20250104),
    auditFile: config.auditFile ?? null,
    budget: config.budget,
    probeQuery: '那本被水泡过的书',
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

  return {
    db,
    persistence,
    platformStore,
    identityService,
    runtimeManager,
    gateway,
    qqAdapter,
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
    qq:
      env.QQBOT_APP_ID && env.QQBOT_APP_SECRET
        ? {
            appId: env.QQBOT_APP_ID,
            appSecret: env.QQBOT_APP_SECRET,
            proactive: env.QQBOT_PROACTIVE === 'true',
          }
        : null,
  }
}

export const MANUAL_CLOCK_HINT = '测试与离线演示请显式传入 ManualClock，避免真实时间影响断言'
export { ManualClock }
