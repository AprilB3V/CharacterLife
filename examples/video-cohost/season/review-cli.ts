/**
 * Interactive closing review.
 *
 *   node examples/video-cohost/season/review-cli.ts <seasonDir> [EP01]
 *
 * Reads `review/EPxx.pending.json`, asks accept/reject for each candidate, then
 * writes the decision into `inbox/`. The running CL applies it on the next sync;
 * this tool never opens the instance database.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { stdin, stdout } from 'node:process'
import type { PendingReviewFile } from './review-files.ts'
import { decisionsFromFile, submitDecision } from './review-files.ts'

async function main(): Promise<void> {
    const dir = resolve(process.argv[2] ?? '')
    if (!process.argv[2]) throw new Error('Usage: review-cli.ts <seasonDir> [EPxx]')
    const reviewDir = join(dir, 'review')
    const name = process.argv[3] ? `${process.argv[3]}.pending.json`
        : readdirSync(reviewDir).filter(item => item.endsWith('.pending.json')).sort().at(-1)
    if (!name) throw new Error(`No pending review in ${reviewDir}`)
    const file = JSON.parse(readFileSync(join(reviewDir, name), 'utf8')) as PendingReviewFile
    const rl = createInterface({ input: stdin })
    // An async line iterator also works when answers are piped in.
    const lines = rl[Symbol.asyncIterator]()
    const ask = async (question: string): Promise<string> => {
        stdout.write(question)
        const next = await lines.next()
        return next.done ? '' : String(next.value)
    }
    try {
        const yes = async (question: string) => /^(y|yes|是|1)$/i.test((await ask(`${question} [y/N] `)).trim())
        console.log(`\n${file.reviewId}：第 ${file.episode} 期收尾审核\n`)
        for (const memory of file.memories) {
            console.log(`- 候选记忆 ${memory.id}：${memory.title}\n  ${memory.content}\n  出处 ${memory.sourceRefs.join('、')}`)
            memory.decision = await yes('  写入长期记忆？') ? 'accept' : 'reject'
        }
        for (const flag of file.flags) {
            console.log(`- 候选 flag ${flag.id}：「${flag.text}」 规则 ${flag.kind}，出处 ${flag.sourceRef}`)
            if (flag.kind === 'needs_clarification') {
                console.log('  游戏数据无法判定，不收。')
                flag.decision = 'reject'
                continue
            }
            if (!await yes('  收为承诺？')) { flag.decision = 'reject'; continue }
            const due = (await ask(`  截止游戏天数${flag.dueDay !== null ? `（回车沿用 ${flag.dueDay}）` : ''}：`)).trim()
            if (due) flag.dueDay = Number(due)
            if (flag.kind === 'money_gte') {
                const value = (await ask(`  资金目标${flag.value !== null ? `（回车沿用 ${flag.value}）` : ''}：`)).trim()
                if (value) flag.value = Number(value)
            }
            flag.decision = 'accept'
        }
    } finally {
        rl.close()
    }
    const path = submitDecision(dir, decisionsFromFile(file))
    console.log(`\n已写入 ${path}；CL 下次同步时应用，结果见审计日志与 review/applied。`)
}

await main()
