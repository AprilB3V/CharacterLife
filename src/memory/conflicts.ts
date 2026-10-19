/**
 * 记忆冲突检测。
 *
 * 角色记忆出问题的真实形态不是「想不起来」，而是：
 * 1. 同一个人说了相反的话（用户先说喜欢安静，后来说讨厌安静）；
 * 2. 同一个标题下内容被改写（约定时间从周日变成周六）；
 * 3. 旧信息从未被清理，仍然被检索出来当事实用。
 *
 * 这个模块只做**确定性检测**，把冲突记录成可审阅的行；不自动删除任何记忆，
 * 也不允许「较新的说法自动覆盖较旧的」在没有确认的情况下改变事实状态。
 * 解析动作（supersede）由显式调用触发。
 */

import type { EpistemicStatus, MemoryEntry } from '../types.ts'
import { tokenize } from '../util/text.ts'

export type ConflictKind = 'contradiction' | 'outdated' | 'duplicate'

export interface ConflictCandidate {
  kind: ConflictKind
  olderId: string
  newerId: string
  subject: string
  detail: string
}

const LIKE = /(?:^|[，。！？、\s])(?:很|挺|特别|超|最)?(?:喜欢|爱|偏爱)([^，。！？；\n]{1,14})/
const DISLIKE = /(?:^|[，。！？、\s])(?:不太|不|没)?(?:喜欢|讨厌|受不了|嫌弃)([^，。！？；\n]{1,14})/

function normalize(text: string): string {
  return text
    .replace(/[，。！？、；：""''（）()\s]/g, '')
    .replace(/[的了呢吧啊呀哦嗯]/g, '')
    .toLowerCase()
}

export interface PreferenceClaim {
  polarity: 'like' | 'dislike'
  subject: string
}

/** 从一句中文里抽取「喜欢/不喜欢 X」的主张；抽不到返回 null。 */
export function extractPreference(text: string): PreferenceClaim | null {
  const dislike = DISLIKE.exec(text)
  const like = LIKE.exec(text)
  if (dislike) {
    const subject = normalize(dislike[1] ?? '')
    if (subject.length >= 2) return { polarity: 'dislike', subject }
  }
  if (like) {
    const subject = normalize(like[1] ?? '')
    if (subject.length >= 2) return { polarity: 'like', subject }
  }
  return null
}

function subjectRelated(a: string, b: string): boolean {
  if (a === b) return true
  if (a.length >= 2 && b.includes(a)) return true
  if (b.length >= 2 && a.includes(b)) return true
  const ta = new Set(tokenize(a))
  const tb = tokenize(b)
  if (ta.size === 0 || tb.length === 0) return false
  const hit = tb.filter((t) => ta.has(t)).length
  return hit / new Set(tb).size >= 0.6
}

export interface DetectOptions {
  nowSim: number
  /** 超过这个时长的低显著度记忆被视为「过时」候选 */
  outdatedAfterMs?: number
}

/**
 * 检测冲突。只返回候选，是否落库、如何处理由持久层决定。
 * 顺序确定：按 (olderId, newerId, kind) 排序，保证同一输入得到同一结果。
 */
export function detectConflicts(
  entries: readonly MemoryEntry[],
  opts: DetectOptions,
): ConflictCandidate[] {
  const active = entries.filter((e) => e.deletedAtSim === null)
  const outdatedAfter = opts.outdatedAfterMs ?? 30 * 24 * 60 * 60 * 1000
  const candidates: ConflictCandidate[] = []

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i]!
      const b = active[j]!
      const older = a.createdAtSim <= b.createdAtSim ? a : b
      const newer = older === a ? b : a

      // 1) 同一主张的正反两面
      const pa = extractPreference(`${a.title} ${a.content}`)
      const pb = extractPreference(`${b.title} ${b.content}`)
      if (pa && pb && pa.polarity !== pb.polarity && subjectRelated(pa.subject, pb.subject)) {
        candidates.push({
          kind: 'contradiction',
          olderId: older.id,
          newerId: newer.id,
          subject: pa.subject,
          detail: `关于「${pa.subject}」出现相反主张：${pa.polarity} vs ${pb.polarity}`,
        })
        continue
      }

      // 2) 同一标题、内容不同（典型的「约定被改写」）
      if (normalize(a.title) === normalize(b.title)) {
        if (normalize(a.content) === normalize(b.content)) {
          candidates.push({
            kind: 'duplicate',
            olderId: older.id,
            newerId: newer.id,
            subject: a.title,
            detail: '标题与内容完全相同（可去重）',
          })
        } else {
          candidates.push({
            kind: 'contradiction',
            olderId: older.id,
            newerId: newer.id,
            subject: a.title,
            detail: `同一标题下内容不一致：${a.content.slice(0, 30)}… ≠ ${b.content.slice(0, 30)}…`,
          })
        }
        continue
      }

      // 3) 过时的低权重记忆 vs 同主题的较新记忆
      const age = opts.nowSim - older.createdAtSim
      if (
        age > outdatedAfter &&
        older.salience < 0.4 &&
        subjectRelated(normalize(older.title), normalize(newer.title))
      ) {
        candidates.push({
          kind: 'outdated',
          olderId: older.id,
          newerId: newer.id,
          subject: older.title,
          detail: `旧记忆已存在 ${Math.round(age / 86400000)} 天且显著度 ${older.salience}，可能已被更新`,
        })
      }
    }
  }

  candidates.sort(
    (x, y) =>
      x.olderId.localeCompare(y.olderId) ||
      x.newerId.localeCompare(y.newerId) ||
      x.kind.localeCompare(y.kind),
  )
  return candidates
}

export type ConflictResolution = 'unresolved' | 'newer_wins' | 'manual'

export interface StoredConflict {
  id: string
  instanceId: string
  kind: ConflictKind
  olderId: string
  newerId: string
  subject: string
  detail: string
  detectedAtSim: number
  resolution: ConflictResolution
  resolvedAtSim: number | null
}

/** 状态权重：用于「较新的说法」是否足够可信去覆盖旧的。 */
export function precedence(status: EpistemicStatus, confirmed: boolean): number {
  const base = status === 'fact' ? 3 : status === 'fiction' ? 2 : 1
  return base + (confirmed ? 1 : 0)
}
