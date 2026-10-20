/**
 * P1 复现：deepseek-flash 在多轮带历史时返回纯空白。
 *
 * 背景：实机联调中，第二轮之后的追问偶尔只拿到降级台词
 * （`EMPTY_REPLY_FALLBACK`）。服务端审计里 `reply.trim().length === 0`。
 *
 * 这个脚本比较三种上下文形态，同一句 system / 同一个问题：
 *   A. 无历史
 *   B. 自然语言历史（assistant 上一轮说了一句话）
 *   C. JSON 信封历史（assistant 上一轮是完整 JSON 信封）
 *
 * 运行：
 *   set "DEEPSEEK_API_KEY=..."
 *   npm run real:blank
 *
 * 判定标准：`text.length` 与 `JSON.parse(text).reply` 是否能拿到非空内容。
 */

import { DeepSeekProvider } from '../../src/conversation/providers/deepseek.ts'
import { buildSystemPrompt, CAPABILITY_NOTE } from '../../src/conversation/context.ts'
import { manifestFor } from '../../src/world/contracts.ts'
import { analyzeMessage } from '../../src/runtime/signals.ts'
import { decideForMessage } from '../../src/runtime/decision.ts'
import {
  createInitialDynamicState,
  createInitialRelationship,
} from '../../src/runtime/state.ts'
import { SeededRng } from '../../src/util/rng.ts'
import { shenZhiweiProfile, shenZhiweiVoice } from '../../examples/characters/shen-zhiwei.ts'
import type { LLMMessage } from '../../src/types.ts'

const QUESTION = process.argv[2]?.trim() || '你到桌边了吗？那边怎么样？'

function buildSystem(question: string): string {
  const profile = shenZhiweiProfile
  const decision = decideForMessage(analyzeMessage(question, profile), {
    profile,
    dynamic: createInitialDynamicState(profile, 0),
    relationship: createInitialRelationship(profile),
    nowSim: 0,
    voice: shenZhiweiVoice,
    rng: new SeededRng(1),
  })
  return buildSystemPrompt({
    profile,
    decision,
    capabilityNote: CAPABILITY_NOTE,
    world: {
      manifest: manifestFor(new Set(['use']), new Set(['desk_01'])),
      confirmed: [],
      unconfirmed: ['use(desk_01) 已提出，世界还没领取'],
    },
  })
}

const PREV_USER = '【用户这条消息】\n你能去桌子旁看看吗？'
const PREV_REPLY_TEXT = '可以。我去看看。'
const PREV_ENVELOPE = JSON.stringify({
  reply: PREV_REPLY_TEXT,
  proposals: [],
  memoryWrites: [],
  worldActions: [{ verb: 'use', target: 'desk_01', reason: '去看看' }],
})

const ARMS: Array<{ label: string; history: LLMMessage[] }> = [
  { label: 'A 无历史', history: [] },
  {
    label: 'B 自然语言历史',
    history: [
      { role: 'user', content: PREV_USER },
      { role: 'assistant', content: PREV_REPLY_TEXT },
    ],
  },
  {
    label: 'C JSON 信封历史',
    history: [
      { role: 'user', content: PREV_USER },
      { role: 'assistant', content: PREV_ENVELOPE },
    ],
  },
]

function summarize(text: string): { reply: string | null; note: string } {
  const trimmed = text.trim()
  if (trimmed.length === 0) {
    return { reply: null, note: `空白（原始长度 ${text.length}，trim 后 0）` }
  }
  try {
    const parsed = JSON.parse(trimmed) as { reply?: unknown }
    const reply = typeof parsed.reply === 'string' ? parsed.reply : null
    return { reply, note: reply && reply.trim().length > 0 ? '正常' : 'reply 为空' }
  } catch {
    return { reply: null, note: '不是合法 JSON' }
  }
}

async function main(): Promise<void> {
  const key = process.env.DEEPSEEK_API_KEY?.trim()
  if (!key) {
    console.log('未检测到 DEEPSEEK_API_KEY：跳过（这不是失败）。')
    return
  }
  const repeat = Math.max(1, Math.min(5, Number(process.env.PROBE_REPEAT ?? 1) || 1))
  const provider = new DeepSeekProvider({ apiKey: key, model: process.env.DEEPSEEK_MODEL })
  const system = buildSystem(QUESTION)

  console.log(`问题：${QUESTION}`)
  console.log(`模型：${provider.model}   每组重复：${repeat}`)
  console.log('')

  const tally: Record<string, { blank: number; total: number }> = {}

  for (const arm of ARMS) {
    tally[arm.label] = { blank: 0, total: 0 }
    for (let round = 1; round <= repeat; round++) {
      const messages: LLMMessage[] = [
        ...arm.history,
        { role: 'user', content: `【用户这条消息】\n${QUESTION}` },
      ]
      const res = await provider.complete({
        system,
        messages,
        temperature: 0.7,
        maxTokens: 800,
        jsonMode: true,
      })
      const { reply, note } = summarize(res.text)
      tally[arm.label]!.total += 1
      if (reply === null) tally[arm.label]!.blank += 1
      console.log(`── ${arm.label} · 第 ${round} 次`)
      console.log(`   text.length = ${res.text.length}  finish = ${res.finishReason ?? '?'}`)
      console.log(`   判定 = ${note}`)
      console.log(`   reply  = ${reply === null ? '(空)' : JSON.stringify(reply.slice(0, 60))}`)
      console.log(`   原文   = ${JSON.stringify(res.text.slice(0, 100))}`)
    }
    console.log('')
  }

  console.log('── 汇总（空白 / 总次数）')
  for (const arm of ARMS) {
    const t = tally[arm.label]!
    console.log(`   ${arm.label}: ${t.blank} / ${t.total}`)
  }
  console.log('')
  console.log('对照口径：若某组空白率显著高于其它两组，说明与该形态相关；')
  console.log('          若三组都偶发空白，则更可能是模型侧的间歇性行为，与历史形态无关。')
}

void main().catch((err: unknown) => {
  console.error('探针失败：', err instanceof Error ? err.stack : err)
  process.exit(1)
})
