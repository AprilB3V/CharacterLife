/**
 * File-based closing review.
 *
 * The running adapter writes `review/EPxx.pending.json`; the streamer (or the CLI)
 * writes decisions to `inbox/EPxx.json`; the adapter applies them in-process on the
 * next sync, so only one writer ever touches the instance database.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FlagCandidate, ReviewDecision, ReviewList } from './director.ts'

export interface PendingReviewFile {
    reviewId: string
    episode: number
    instructions: string
    memories: Array<{ id: string; title: string; content: string; sourceRefs: string[]; decision: 'pending' | 'accept' | 'reject' }>
    flags: Array<{ id: string; text: string; kind: string; value: number | null; dueDay: number | null; sourceRef: string; decision: 'pending' | 'accept' | 'reject' }>
}

const INSTRUCTIONS = '把 decision 改成 accept 或 reject。Flag 必须填写 dueDay（游戏天数，超过这一天仍未达成即违约）；'
    + 'money_gte 需要 value。needs_clarification 无法用游戏数据判定，只能 reject。'
    + '候选文字以运行时保存的版本为准，修改本文件中的文字不会生效。'

export function writePendingReview(dir: string, review: ReviewList, flags: readonly FlagCandidate[]): string {
    const reviewDir = join(dir, 'review')
    mkdirSync(reviewDir, { recursive: true })
    const file: PendingReviewFile = {
        reviewId: review.reviewId, episode: review.episode, instructions: INSTRUCTIONS,
        memories: review.memories.map(memory => ({ id: memory.id, title: memory.title, content: memory.content, sourceRefs: memory.sourceRefs, decision: 'pending' })),
        flags: flags.filter(flag => review.flags.includes(flag.id)).map(flag => ({ id: flag.id, text: flag.text, kind: flag.kind,
            value: flag.value ?? null, dueDay: flag.dueDay ?? null, sourceRef: flag.sourceRef, decision: 'pending' })),
    }
    const path = join(reviewDir, `${review.reviewId}.pending.json`)
    writeFileSync(path, `${JSON.stringify(file, null, 4)}\n`, 'utf8')
    return path
}

/** Convert an edited pending file into decisions; pending items are left out. */
export function decisionsFromFile(file: PendingReviewFile): ReviewDecision {
    return {
        reviewId: file.reviewId,
        memories: file.memories.filter(item => item.decision !== 'pending').map(item => ({ id: item.id, decision: item.decision as 'accept' | 'reject' })),
        flags: file.flags.filter(item => item.decision !== 'pending').map(item => ({ id: item.id, decision: item.decision as 'accept' | 'reject',
            ...(item.dueDay !== null ? { dueDay: item.dueDay } : {}), ...(item.value !== null ? { value: item.value } : {}) })),
    }
}

export function submitDecision(dir: string, decision: ReviewDecision): string {
    const inbox = join(dir, 'inbox')
    mkdirSync(inbox, { recursive: true })
    const path = join(inbox, `${decision.reviewId}.json`)
    writeFileSync(path, `${JSON.stringify(decision, null, 4)}\n`, 'utf8')
    return path
}

/** Read inbox decisions; each file is moved aside after the callback handles it. */
export function drainInbox(dir: string, apply: (decision: ReviewDecision) => void): number {
    const inbox = join(dir, 'inbox')
    if (!existsSync(inbox)) return 0
    let count = 0
    for (const name of readdirSync(inbox).filter(item => item.endsWith('.json')).sort()) {
        const path = join(inbox, name)
        let target = 'applied'
        try {
            const text = readFileSync(path, 'utf8')
            const decision = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as ReviewDecision
            if (typeof decision?.reviewId !== 'string') throw new Error('Missing reviewId')
            apply(decision)
            count++
        } catch {
            target = 'failed'
        }
        const done = join(dir, 'review', target)
        mkdirSync(done, { recursive: true })
        renameSync(path, join(done, `${Date.now()}-${name}`))
    }
    return count
}
