/**
 * CharacterLife 六语义微内核 · 公共入口（V0.5）
 *
 * 外部项目（例如 Free Roam）只应从这里 import。内核零依赖，不认识任何平台、
 * 具体世界或对话协议；陪伴角色（src/runtime、src/conversation、src/adapters …）
 * 是建在它上面的一个扩展。
 */

export * from './types.ts'

// 角色内核与六个语义槽
export { AgentCore } from './agent.ts'
export type { AgentCoreOptions, KernelRuntimeState, ProposalOutcome, StateAppliedEvent } from './agent.ts'
export * from './semantics/index.ts'

// 多角色宿主
export { AgentHost } from './host.ts'
export type { AgentHostOptions, HostHooks, SteppableClock, WorldDriver } from './host.ts'

// 自主循环：唤醒 → Mind → 准入 → 世界 → 结算
export * from './cycle/waker.ts'
export * from './cycle/mind.ts'
export * from './cycle/llm-mind.ts'
export * from './cycle/replay.ts'
export * from './cycle/bridge.ts'
export * from './cycle/runner.ts'

// 世界端口（协议、准入闸门、动作服务）
export * from './world/contracts.ts'
export * from './world/service.ts'
export * from './world/admission.ts'
export * from './world/observation.ts'
export * from './world/state.ts'

// 提议—裁决、审计、记忆、状态
export * from './policy/policy.ts'
export * from './policy/audit.ts'
export * from './memory/store.ts'
export * from './memory/ranking.ts'
export * from './memory/conflicts.ts'
export * from './state.ts'
export * from './storage/snapshot.ts'

// 可注入的时间、id、随机源与文本工具
export * from './util/clock.ts'
export * from './util/ids.ts'
export * from './util/rng.ts'
export * from './util/text.ts'
