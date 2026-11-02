/**
 * CharacterLife · runtime 公共入口（`characterlife/runtime`）。
 *
 * 扩展（例如 CharacterLife-VideoCohost）通过 `InstanceExtension` 钩子接入单个实例：
 * 同步世界观察、注入上下文、结算承诺、贡献后台插件。这里列出的就是扩展可依赖的面，
 * 没有列出的文件属于内部实现，可能随时重构。
 */

export { InstanceRuntimeManager, seedIdCounters, snapshotInstance, createAudit } from './instance-runtime.ts'
export type {
    InstanceRuntime,
    InstanceRuntimeDeps,
    InstanceExtension,
    InstanceExtensionContext,
    SendOptions,
} from './instance-runtime.ts'
export { MemoryReviewQueue } from './memory-review.ts'
export type { MemoryReviewMode, PendingMemory } from './memory-review.ts'
export { CharacterWorkspace, parseDueOffsetDays } from './workspace.ts'
export type {
    WorkspaceOptions,
    WorkspaceView,
    ProposalOutcome,
    AdvanceOutcome,
    PendingMessage,
    TrackedPromise,
    StateSink,
    WorkspaceStateDump,
} from './workspace.ts'
