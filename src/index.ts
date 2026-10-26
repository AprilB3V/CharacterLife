/**
 * CharacterLife 公共入口。
 *
 * 引擎可以脱离 DeepSeek Harness 独立运行：只依赖 Node 内置模块。
 * 这里导出四个模块的稳定接口，供 CLI 演示、测试、以及未来的
 * SillyTavern / 游戏引擎适配层使用。
 */

/* 类型 */
export type * from './types.ts'

/* 工具层 */
export { ManualClock, SystemClock, formatSim, DAY, HOUR } from './kernel/util/clock.ts'
export type { Clock } from './kernel/util/clock.ts'
export { SeededRng } from './kernel/util/rng.ts'
export type { Rng } from './kernel/util/rng.ts'
export { SequentialIdFactory, EntropyIdFactory, createId } from './kernel/util/ids.ts'
export type { IdFactory } from './kernel/util/ids.ts'
export { detectInjectionMarkers, sanitizeForMemory, tokenize, lexicalOverlap } from './kernel/util/text.ts'

/* 存储 */
export { SnapshotStore } from './kernel/storage/snapshot.ts'
export type { SnapshotSection, SnapshotMeta } from './kernel/storage/snapshot.ts'

/* Memory */
export { MemoryStore, MEMORY_SCHEMA_VERSION } from './kernel/memory/store.ts'
export type { MemoryWriteInput, RetrievedMemory, MemoryExport } from './kernel/memory/store.ts'

/* Policy */
export {
  PolicyEngine,
  CONVERSATION_ACTOR,
  RUNTIME_ACTOR,
  OWNER_ACTOR,
  OBSERVER_ACTOR,
  hasCapability,
} from './kernel/policy/policy.ts'
export type { Actor, PolicyContext, MemoryWriteVerdict } from './kernel/policy/policy.ts'
export { AuditLog } from './kernel/policy/audit.ts'
export type { AuditEvent, AuditEventType } from './kernel/policy/audit.ts'

/* Runtime */
export { CharacterWorkspace, parseDueOffsetDays } from './runtime/workspace.ts'
export type {
  WorkspaceOptions,
  WorkspaceView,
  ProposalOutcome,
  AdvanceOutcome,
  PendingMessage,
  TrackedPromise,
} from './runtime/workspace.ts'
export { Timeline } from './runtime/timeline.ts'
export { analyzeMessage, isAcceptance } from './runtime/signals.ts'
export { decideForMessage, decideForIdle, decideForEvent } from './runtime/decision.ts'
export {
  createInitialDynamicState,
  createInitialRelationship,
  deriveStage,
  applyProposal,
  canonicalizeProposal,
  milestoneDelta,
} from './kernel/state.ts'
export type { DecisionContext } from './runtime/decision.ts'
export type { StateSlice } from './kernel/state.ts'

/* Conversation */
export { ConversationService, DEFAULT_CONVERSATION_CONFIG } from './conversation/service.ts'
export type {
  ConversationConfig,
  ConversationServiceOptions,
  ConversationWorldBinding,
} from './conversation/service.ts'
export { MockProvider, createMockProvider } from './conversation/providers/mock.ts'
export type { MockProviderOptions } from './conversation/providers/mock.ts'
export {
  DeepSeekProvider,
  ProviderError,
  hasDeepSeekCredentials,
  deepSeekConfigFromEnv,
} from './conversation/providers/deepseek.ts'
export type { DeepSeekProviderOptions } from './conversation/providers/deepseek.ts'
export {
  buildSystemPrompt,
  buildMessages,
  renderMemoryData,
  renderWorldPromptSection,
  parseEnvelope,
  CAPABILITY_NOTE,
  OUTPUT_PROTOCOL,
} from './conversation/context.ts'
export type { ParseEnvelopeOptions, SystemPromptInput, WorldPromptContext } from './conversation/context.ts'

/* ==========================================================================
 * V0.1.1 新增：Character Persistence / Context Manager / Rehydration
 * ========================================================================== */

/* Character Template（只读、版本化） */
export {
  defineTemplate,
  verifyTemplate,
  checkTemplateVersion,
  hashTemplateContent,
  stableStringify,
  TemplateIntegrityError,
} from './character/template.ts'
export type {
  CharacterTemplate,
  TemplateEventSpec,
  TemplateInput,
  TemplateVersionCheck,
} from './character/template.ts'

/* Instance / Session */
export { createInstanceRecord, createSessionRecord } from './character/instance.ts'
export type {
  CharacterInstance,
  SessionRecord,
  SessionEndReason,
  CreateInstanceInput,
} from './character/instance.ts'

/* Rehydration（8 步恢复） */
export { CharacterRehydrator, replayState } from './character/rehydration.ts'
export type {
  RehydrationReport,
  RehydrationStep,
  RehydratedWorkspace,
  RehydrationOptions,
} from './character/rehydration.ts'

/* Persistent Session */
export { PersistentSession, openPersistentSession } from './character/persistent-session.ts'
export type { PersistentSessionOptions } from './character/persistent-session.ts'

/* SQLite 持久层 */
export { CharacterDatabase } from './persistence/database.ts'
export { CharacterPersistence, MemoryWriteRejected } from './persistence/store.ts'
export type {
  PersistedEvent,
  PersistedEventType,
  PersistedState,
  SnapshotRecord,
  ContextUsageRecord,
  StatePatchData,
} from './persistence/store.ts'
export { SqliteSink } from './persistence/sink.ts'
export { SCHEMA_VERSION } from './persistence/schema.ts'

/* Context Manager */
export {
  ContextManager,
  ContextBudgetExceededError,
  groupTurns,
  DEFAULT_CONTEXT_BUDGET,
} from './context/manager.ts'
export type {
  ContextBudget,
  ContextPlan,
  DegradationLevel,
  ContextPlanInput,
  DialogueTurn,
} from './context/manager.ts'
export { estimateTokens, truncateToTokens } from './context/tokens.ts'

/* 记忆排序与冲突 */
export { rankMemories } from './kernel/memory/ranking.ts'
export type { RankedMemory, RankParts } from './kernel/memory/ranking.ts'
export { detectConflicts, extractPreference, precedence } from './kernel/memory/conflicts.ts'
export type {
  StoredConflict,
  ConflictKind,
  ConflictResolution,
  ConflictCandidate,
} from './kernel/memory/conflicts.ts'
export type { MemorySink, MemoryWriteInput as MemoryWriteInputV2 } from './kernel/memory/store.ts'

/* 工作区扩展类型 */
export type { StateSink, WorkspaceStateDump } from './runtime/workspace.ts'

/* ==========================================================================
 * V0.2：跨平台适配层
 * ========================================================================== */

/* 适配器协议（新平台实现这个接口即可） */
export { InboundParseError, isNormalizedMessage } from './adapters/protocol.ts'
export type {
  NormalizedMessage,
  OutboundMessage,
  PlatformAdapter,
  PlatformBinding,
  PlatformCapabilities,
  PlatformIdentity,
  DeliveryError,
  MessageDeliveryResult,
  SceneKind,
} from './adapters/protocol.ts'

/* QQ 官方适配器 */
export { QQAdapter, QQ_SCENE_LIMITS } from './adapters/qq/adapter.ts'
export type { QQAdapterOptions } from './adapters/qq/adapter.ts'
export { QQApiClient, FetchTransport, MockTransport } from './adapters/qq/api-client.ts'
export type { QQTransport, QQTransportRequest, QQTransportResponse, QQCredentials } from './adapters/qq/api-client.ts'
export { parseQQEvent, sanitizeQQContent, encodeReplyTarget, decodeReplyTarget } from './adapters/qq/events.ts'
export type { QQReplyTarget } from './adapters/qq/events.ts'
export {
  verifyQQWebhookSignature,
  signWebhookChallenge,
  derivePublicKeyHex,
  isUrlVerificationEvent,
  safeEqual,
} from './adapters/qq/webhook.ts'
export type { SignatureVerifyResult } from './adapters/qq/webhook.ts'

/* OneBot 11 适配器（NapCat / Lagrange.OneBot / SnowLuma） */
export { OneBotAdapter, ONEBOT_DEFAULT_CAPABILITIES } from './adapters/onebot/adapter.ts'
export type { OneBotAdapterOptions } from './adapters/onebot/adapter.ts'
export { OneBotApiClient, FetchTransport as OneBotFetchTransport, MockTransport as OneBotMockTransport } from './adapters/onebot/api-client.ts'
export type {
  OneBotTransport,
  OneBotTransportRequest,
  OneBotTransportResponse,
  OneBotResponse,
} from './adapters/onebot/api-client.ts'
export {
  parseOneBotEvent,
  extractContent,
  sanitizeOneBotText,
  anonymizeUserId,
  isCommandText,
  encodeReplyTarget as encodeOneBotReplyTarget,
  decodeReplyTarget as decodeOneBotReplyTarget,
} from './adapters/onebot/events.ts'
export type { OneBotParseOptions, OneBotReplyTarget, ExtractedContent } from './adapters/onebot/events.ts'
export { verifyOneBotSignature, hmacSha1Hex } from './adapters/onebot/webhook.ts'
export type { OneBotSignatureOptions, OneBotSignatureResult } from './adapters/onebot/webhook.ts'
export { createOneBotReportServer } from './adapters/onebot/report-server.ts'
export type { OneBotReportServerOptions, OneBotReportServerHandle } from './adapters/onebot/report-server.ts'

/* SillyTavern / OpenAI 兼容 */
export { SillyTavernAdapter } from './adapters/sillytavern/adapter.ts'
export {
  buildNormalizedMessage,
  extractFromChatRequest,
  externalContextNotice,
  buildChatCompletionResponse,
  buildSSEChunks,
  buildModelsResponse,
  SillyTavernRequestError,
} from './adapters/sillytavern/openai.ts'
export type { OpenAIChatRequest, OpenAIChatMessage, TextExtraction } from './adapters/sillytavern/openai.ts'

/* Identity / 绑定 */
export { IdentityService, hashCode } from './identity/identity-service.ts'
export type { ResolvedIdentity, BindCodeResult, BindError } from './identity/identity-service.ts'
export { PlatformStore } from './persistence/platform-store.ts'
export type { BindingSource, BindingCodeRecord, RedeemFailure, RedeemResult } from './persistence/platform-store.ts'

/* Gateway / API Server / 运行时装配 */
export { MessageGateway, identityKey } from './api/gateway.ts'
export type { GatewayOptions, InboundOutcome, InboundStatus } from './api/gateway.ts'
export { createApiServer } from './api/server.ts'
export type { ApiServerOptions, ApiServerHandle } from './api/server.ts'
export { handleCommand } from './api/commands.ts'
export type { CommandContext, CommandResult } from './api/commands.ts'
export { assembleRuntime, loadEnvConfig, defaultTemplate, chooseProvider } from './api/runtime-factory.ts'
export type { RuntimeConfig, RuntimeBundle, EnvConfig } from './api/runtime-factory.ts'
export { InstanceRuntimeManager, seedIdCounters, snapshotInstance } from './runtime/instance-runtime.ts'
export type { InstanceRuntime, InstanceRuntimeDeps, SendOptions } from './runtime/instance-runtime.ts'

/* ==========================================================================
 * 世界交互（第一阶段：HTTP 闭环 · 内存队列）
 * ========================================================================== */

export { WorldService, validateWorldEvent } from './kernel/world/service.ts'
export type { WorldServiceOptions } from './kernel/world/service.ts'
export { narrationFor, isTerminalStatus, allowsCompletionClaim } from './kernel/world/state.ts'
export { buildWorldEventContext, worldContextLines } from './kernel/world/observation.ts'
export { admitWorldIntents } from './kernel/world/admission.ts'
export type {
  WorldIntentAdmission,
  WorldIntentAdmissionInput,
  WorldIntentRejection,
  WorldIntentRejectCode,
} from './kernel/world/admission.ts'
export { WORLD_RESULTS, WORLD_EVENT_KINDS, WORLD_LIMITS, WORLD_ACTION_CATALOG, manifestFor, findCapability } from './kernel/world/contracts.ts'
export type { WorldActionCapability } from './kernel/world/contracts.ts'
export type {
  WorldActionResult,
  WorldActionStatus,
  WorldActionNarration,
  WorldActionSpec,
  WorldActionRecord,
  WorldActionView,
  WorldActionOutcome,
  WorldEvent,
  WorldEventKind,
  WorldIngestResult,
  WorldAdmitResult,
  WorldAdmitErrorCode,
  WorldIngestErrorCode,
} from './kernel/world/contracts.ts'
export { createWorldRouter, WORLD_DEV_ACTION } from './api/world-routes.ts'
export type { WorldRouter, WorldRouterOptions } from './api/world-routes.ts'
export type { WorldRuntimeConfig } from './api/runtime-factory.ts'
