/**
 * 记忆检索打分（从 MemoryStore 抽出的纯函数）。
 *
 * 抽出的原因：SQLite 持久层需要「把库里的行取出来再按同一套规则排序」，
 * 如果打分逻辑留在两个地方，检索行为迟早会不一致。
 *
 * 分数 = 0.45·词面重合 + 0.25·显著度 + 0.20·时间衰减 + 0.10·认识论状态
 *      (+0.05 用户已确认，−0.10 不可信来源)
 */

import type { EpistemicStatus, MemoryEntry } from '../types.ts'
import { lexicalOverlap, tokenize } from '../util/text.ts'

export interface RankParts {
  lexical: number
  salience: number
  recency: number
  status: number
  confirmed: number
}

export interface RankedMemory {
  entry: MemoryEntry
  score: number
  parts: RankParts
}

export interface RankOptions {
  nowSim: number
  limit?: number
  /** 累计字符预算（标题+正文） */
  budgetChars?: number
  halfLifeMs?: number
}

const DEFAULT_HALF_LIFE = 2 * 24 * 60 * 60 * 1000

function statusWeight(status: EpistemicStatus): number {
  switch (status) {
    case 'fact':
      return 1
    case 'fiction':
      return 0.75
    case 'speculation':
      return 0.4
  }
}

export function rankMemories(
  entries: readonly MemoryEntry[],
  query: string,
  opts: RankOptions,
): RankedMemory[] {
  const halfLife = opts.halfLifeMs ?? DEFAULT_HALF_LIFE
  const limit = opts.limit ?? 6
  const budget = opts.budgetChars ?? 1200
  const qTokens = tokenize(query)

  const scored: RankedMemory[] = []
  for (const entry of entries) {
    if (entry.deletedAtSim !== null) continue
    const docTokens = tokenize(`${entry.title} ${entry.content} ${entry.tags.join(' ')}`)
    const lexical = qTokens.length === 0 ? 0 : lexicalOverlap(qTokens, docTokens)
    const age = Math.max(0, opts.nowSim - entry.createdAtSim)
    const recency = Math.pow(0.5, age / halfLife)
    const status = statusWeight(entry.status)
    const confirmed = entry.confirmed ? 1 : 0
    let score = 0.45 * lexical + 0.25 * entry.salience + 0.2 * recency + 0.1 * status + 0.05 * confirmed
    if (entry.trust === 'untrusted') score -= 0.1
    scored.push({ entry, score, parts: { lexical, salience: entry.salience, recency, status, confirmed } })
  }

  scored.sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id))

  const out: RankedMemory[] = []
  let used = 0
  for (const item of scored) {
    if (out.length >= limit) break
    const cost = item.entry.title.length + item.entry.content.length
    if (out.length > 0 && used + cost > budget) break
    out.push(item)
    used += cost
  }
  return out
}
