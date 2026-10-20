/**
 * 世界动作的派生状态（纯函数，无 IO、不引用 Runtime）。
 *
 * 放在独立文件的原因：`src/runtime/workspace.ts` 第二阶段需要读取叙述许可，
 * 而 workspace 不能反向依赖世界服务。这里只有类型与判断，没有状态。
 */

import type {
  WorldActionNarration,
  WorldActionRecord,
  WorldActionStatus,
} from './contracts.ts'

/** 终局状态：一旦进入就不再接受新的结果（迟到回执除外，由服务层单独处理）。 */
const TERMINAL: ReadonlySet<WorldActionStatus> = new Set<WorldActionStatus>([
  'succeeded',
  'failed',
  'rejected',
  'expired',
])

export function isTerminalStatus(status: WorldActionStatus): boolean {
  return TERMINAL.has(status)
}

/**
 * 叙述许可。
 *
 * 核心区分在 `expired`：
 * - 从未被领取过 → 世界不可能执行它 → 可以说"没做成"（failed）
 * - 被领取过但回执丢了 → **可能已经发生** → 只能说"不知道"（uncertain）
 *
 * 没有这条分支，系统就无法区分"确定没做"和"可能做了但不知道"，
 * 而这正是"离线时声称完成"最容易钻的缝。
 */
export function narrationFor(
  action: Pick<WorldActionRecord, 'status' | 'firstDispatchedAtSim'>,
): WorldActionNarration {
  switch (action.status) {
    case 'succeeded':
      return 'done'
    case 'failed':
    case 'rejected':
      return 'failed'
    case 'pending':
      return 'intent'
    case 'dispatched':
      return 'uncertain'
    case 'expired':
      return action.firstDispatchedAtSim === null ? 'failed' : 'uncertain'
  }
}

/** 只有 `done` 允许回复出现完成时态；其余一律视为"未确认"。 */
export function allowsCompletionClaim(narration: WorldActionNarration): boolean {
  return narration === 'done'
}
