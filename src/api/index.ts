/**
 * CharacterLife · api 公共入口（`characterlife/api`）。
 *
 * 组装运行时、读取环境配置、启动 HTTP 服务。
 */

export { assembleRuntime, loadEnvConfig, defaultTemplate, chooseProvider, MANUAL_CLOCK_HINT } from './runtime-factory.ts'
export type { RuntimeConfig, RuntimeBundle, WorldRuntimeConfig, EnvConfig } from './runtime-factory.ts'
export { createApiServer } from './server.ts'
export type { ApiCredential, ApiServerOptions, ApiServerHandle } from './server.ts'
