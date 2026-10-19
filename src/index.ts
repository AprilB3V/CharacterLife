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
export { ManualClock, SystemClock, formatSim, DAY, HOUR } from './util/clock.ts'
export type { Clock } from './util/clock.ts'
export { SeededRng } from './util/rng.ts'
export type { Rng } from './util/rng.ts'
export { SequentialIdFactory, EntropyIdFactory, createId } from './util/ids.ts'
export type { IdFactory } from './util/ids.ts'
export { detectInjectionMarkers, sanitizeForMemory, tokenize, lexicalOverlap } from './util/text.ts'

/* 存储 */
export { SnapshotStore } from './storage/snapshot.ts'
export type { SnapshotSection, SnapshotMeta } from './storage/snapshot.ts'

/* Memory */
export { MemoryStore, MEMORY_SCHEMA_VERSION } from './memory/store.ts'
export type { MemoryWriteInput, RetrievedMemory, MemoryExport } from './memory/store.ts'

/* Policy */
export {
  PolicyEngine,
  CONVERSATION_ACTOR,
  RUNTIME_ACTOR,
  OWNER_ACTOR,
  OBSERVER_ACTOR,
  hasCapability,
} from './policy/policy.ts'
export type { Actor, PolicyContext, MemoryWriteVerdict } from './policy/policy.ts'
export { AuditLog } from './policy/audit.ts'
export type { AuditEvent, AuditEventType } from './policy/audit.ts'

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
} from './runtime/state.ts'
export type { DecisionContext } from './runtime/decision.ts'
export type { StateSlice } from './runtime/state.ts'

/* Conversation */
export { ConversationService, DEFAULT_CONVERSATION_CONFIG } from './conversation/service.ts'
export type { ConversationConfig, ConversationServiceOptions } from './conversation/service.ts'
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
  parseEnvelope,
  CAPABILITY_NOTE,
} from './conversation/context.ts'

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
export { rankMemories } from './memory/ranking.ts'
export type { RankedMemory, RankParts } from './memory/ranking.ts'
export { detectConflicts, extractPreference, precedence } from './memory/conflicts.ts'
export type {
  StoredConflict,
  ConflictKind,
  ConflictResolution,
  ConflictCandidate,
} from './memory/conflicts.ts'
export type { MemorySink, MemoryWriteInput as MemoryWriteInputV2 } from './memory/store.ts'

/* 工作区扩展类型 */
export type { StateSink, WorkspaceStateDump } from './runtime/workspace.ts'
