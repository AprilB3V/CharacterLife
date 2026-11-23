/**
 * K1 身份恒定：身份指纹。
 *
 * 指纹 = 角色核心设定的规范化哈希，代表"这个角色是谁"。
 * 动机、心情、关系等可变状态不在核心设定里，它们的变化不影响指纹。
 *
 * 账本里每条与角色有关的记录都带当时的指纹；指纹变化之间必须有一条
 * `identity_revision` 记录 —— 人设漂移从"靠感觉发现"变成"一条可以检出的记录"。
 */

import { contentHash } from './canonical.ts'
import type { LedgerRecord } from './ledger.ts'

/** 核心设定的指纹。参数是只读的人格对象（任何可规范化的结构）。 */
export function identityFingerprint(persona: unknown): string {
  return contentHash(persona)
}

export interface IdentityViolation {
  /** 指纹发生变化的那条记录 */
  seq: number
  from: string
  to: string
}

/**
 * 检查指纹连续性：任意两条相邻（带指纹的）记录的指纹不同，
 * 二者之间（含后一条）必须存在一条 `identity_revision` 记录，且它声明的 to 等于新指纹。
 */
export function checkIdentityContinuity(
  records: readonly LedgerRecord[],
  contentOf: (seq: number) => unknown,
): IdentityViolation[] {
  const violations: IdentityViolation[] = []
  let current: string | null = null
  let pendingRevisionTo: string | null = null
  for (const r of records) {
    if (r.kind === 'identity_revision') {
      const c = contentOf(r.seq) as { to?: unknown } | undefined
      pendingRevisionTo = typeof c?.to === 'string' ? c.to : null
    }
    if (r.fingerprint === null) continue
    if (current === null) {
      current = r.fingerprint
      continue
    }
    if (r.fingerprint !== current) {
      if (pendingRevisionTo !== r.fingerprint) violations.push({ seq: r.seq, from: current, to: r.fingerprint })
      current = r.fingerprint
    }
    pendingRevisionTo = null
  }
  return violations
}
