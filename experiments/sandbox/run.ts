/**
 * 文字箱庭：跑一个角色的一天，输出时间线、JSONL 日志与摘要。
 *
 *   npm run sandbox                                   # RuleMind，B 组，种子 1，10 小时
 *   npm run sandbox -- --condition A --seed 3
 *   npm run sandbox -- --intervene social@12:00=0.95  # H5 干预
 *   npm run sandbox -- --mind deepseek                # 真实模型（需 DEEPSEEK_API_KEY），自动录制
 *   npm run sandbox -- --mind replay --replay <file>  # 零成本回放一次录制
 *
 * 产物（默认 experiments/sandbox/.data/<run>/）：
 *   log.jsonl        角色侧日志：每次唤醒的原因、驱力、处境、想法、动作与准入结果
 *   truth.jsonl      世界真值日志：角色看不到的因果（谁买走了面包、NPC 何时离开）
 *   calls.json       真实模型的请求与响应录制（仅 --mind deepseek）
 *   summary.json     汇总
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DeepSeekProvider } from '../../src/conversation/providers/deepseek.ts'
import { LlmMind } from '../../src/kernel/cycle/llm-mind.ts'
import type { RecordedCall } from '../../src/kernel/cycle/replay.ts'
import { RecordingProvider, ReplayProvider } from '../../src/kernel/cycle/replay.ts'
import type { Mind } from '../../src/kernel/cycle/mind.ts'
import type { AutonomyLogRecord } from '../../src/kernel/cycle/runner.ts'
import { HOUR } from '../../src/kernel/util/clock.ts'
import type { Condition } from './scenario.ts'
import { createSandbox, runSandbox } from './scenario.ts'
import { summarize } from './summary.ts'

interface Args {
  mind: 'rule' | 'deepseek' | 'replay'
  condition: Condition
  seed: number
  hours: number
  intervene: { atSim: number; drive: string; value: number } | null
  replay: string | null
  out: string | null
  quiet: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { mind: 'rule', condition: 'B', seed: 1, hours: 10, intervene: null, replay: null, out: null, quiet: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const v = argv[i + 1]
    switch (a) {
      case '--mind':
        if (v !== 'rule' && v !== 'deepseek' && v !== 'replay') throw new Error('--mind 只能是 rule / deepseek / replay')
        args.mind = v
        i++
        break
      case '--condition':
        if (v !== 'A' && v !== 'B') throw new Error('--condition 只能是 A / B')
        args.condition = v
        i++
        break
      case '--seed':
        args.seed = Number.parseInt(v ?? '', 10)
        i++
        break
      case '--hours':
        args.hours = Number(v)
        i++
        break
      case '--intervene':
        args.intervene = parseIntervention(v ?? '')
        i++
        break
      case '--replay':
        args.replay = v ?? null
        i++
        break
      case '--out':
        args.out = v ?? null
        i++
        break
      case '--quiet':
        args.quiet = true
        break
      default:
        throw new Error(`未知参数 ${a}`)
    }
  }
  if (!Number.isInteger(args.seed)) throw new Error('--seed 必须是整数')
  return args
}

/** `social@12:00=0.95` → Day1 12:00 把 social 设为 0.95 */
export function parseIntervention(text: string): { atSim: number; drive: string; value: number } {
  const m = /^([a-z][a-z0-9_]*)@(\d{1,2}):(\d{2})=([0-9.]+)$/.exec(text)
  if (!m) throw new Error('--intervene 格式：<drive>@HH:MM=<0..1>，例如 social@12:00=0.95')
  return { drive: m[1]!, atSim: Number(m[2]) * HOUR + Number(m[3]) * 60_000, value: Number(m[4]) }
}

const NAMES: Record<string, string> = { npc_lin: '林姐', npc_zhou: '周老师', workshop: '工作室', bakery: '面包房', plaza: '广场' }

function pretty(r: AutonomyLogRecord): string | null {
  switch (r.type) {
    case 'start':
      return `${r.clock}  ▶ 开始（Mind=${r.mind}，驱力唤醒=${r.condition.useDrives ? '开' : '关'}，Mind 可见驱力=${r.condition.driveInputToMind ? '是' : '否'}）`
    case 'intervention':
      return `${r.clock}  ⚡ 实验干预：${r.drive} = ${r.value}`
    case 'observation':
      return `${r.clock}    👀 ${r.events.join('，')}`
    case 'outcome': {
      const mark = r.status === 'succeeded' ? '✓' : r.status === 'expired' ? '?' : '✗'
      const drives = r.driveChanges.map((c) => `${c.path.replace('drives.', '')}→${String(c.value)}`).join(' ')
      return `${r.clock}    ${mark} ${r.action} ${r.status}${drives ? `   [${drives}]` : ''}`
    }
    case 'wake': {
      const why = r.reasons.map((x) => `${x.kind}${x.kind === 'drive' ? `:${x.detail}` : ''}`).join('+')
      const d = Object.entries(r.drives)
        .map(([k, v]) => `${k[0]}${v.toFixed(2)}`)
        .join(' ')
      const where = NAMES[r.situation.location ?? ''] ?? r.situation.location ?? '?'
      const act = r.action ?? '（不行动）'
      const adm = r.admission && !r.admission.ok ? `  ⛔ ${r.admission.code}` : ''
      const err = r.error ? `  ⚠ ${r.error}` : ''
      return `${r.clock}  ◆ 醒[${why}] ${d} @${where} → ${act}${adm}${err}${r.thought ? `  「${r.thought}」` : ''}`
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  let mind: Mind | undefined
  let recorder: RecordingProvider | null = null
  if (args.mind === 'deepseek') {
    const key = process.env.DEEPSEEK_API_KEY
    if (!key) {
      console.log('未检测到 DEEPSEEK_API_KEY：跳过真实模型运行（这不是失败）。用 --mind rule 可零成本运行。')
      return
    }
    recorder = new RecordingProvider(
      new DeepSeekProvider({ apiKey: key, baseUrl: process.env.DEEPSEEK_BASE_URL, model: process.env.DEEPSEEK_MODEL }),
    )
    mind = new LlmMind({ provider: recorder })
  } else if (args.mind === 'replay') {
    if (!args.replay) throw new Error('--mind replay 需要 --replay <calls.json>')
    const calls = JSON.parse(readFileSync(args.replay, 'utf8')) as RecordedCall[]
    mind = new LlmMind({ provider: new ReplayProvider(calls) })
  }

  const runName = `${args.mind}-${args.condition}-s${args.seed}${args.intervene ? `-iv_${args.intervene.drive}` : ''}`
  const outDir = args.out ?? join(process.cwd(), 'experiments', 'sandbox', '.data', runName)
  mkdirSync(outDir, { recursive: true })

  const records: AutonomyLogRecord[] = []
  const sb = createSandbox({
    seed: args.seed,
    condition: args.condition,
    mind,
    logger: (r) => {
      records.push(r)
      if (!args.quiet) {
        const line = pretty(r)
        if (line) console.log(line)
      }
    },
  })

  await runSandbox(sb, { hours: args.hours, intervention: args.intervene })

  const summary = summarize(records, sb.town.truth, { intervention: args.intervene })
  writeFileSync(join(outDir, 'log.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  writeFileSync(join(outDir, 'truth.jsonl'), sb.town.truth.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
  writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ run: runName, args, ...summary }, null, 2), 'utf8')
  if (recorder) writeFileSync(join(outDir, 'calls.json'), JSON.stringify(recorder.calls, null, 2), 'utf8')
  const integrity = sb.agent.integrity
  if (integrity) {
    // 完整性账本（宪法 K3）：一行一条记录，附内容本体；任何人可用 verifyChain 离线核对
    const ledger = integrity.ledger.export()
    const contents = new Map(ledger.contents)
    writeFileSync(
      join(outDir, 'ledger.jsonl'),
      ledger.records.map((r) => JSON.stringify({ ...r, content: contents.get(r.seq) ?? null })).join('\n') + '\n',
      'utf8',
    )
  }

  console.log('')
  console.log(`唤醒 ${summary.wakes} 次；登记动作 ${summary.admitted} 个（被闸门拒绝 ${summary.gateRejected}）`)
  console.log(`世界结算：成功 ${summary.outcomes.succeeded ?? 0} / 失败 ${summary.outcomes.failed ?? 0} / 被拒 ${summary.outcomes.rejected ?? 0}`)
  console.log(`动作分布：${Object.entries(summary.actions).map(([k, n]) => `${k}×${n}`).join('  ')}`)
  console.log(`唤醒原因：${Object.entries(summary.wakeReasons).map(([k, n]) => `${k}×${n}`).join('  ')}`)
  if (summary.tokens.calls > 0) {
    console.log(`模型调用 ${summary.tokens.calls} 次，prompt ${summary.tokens.prompt} / completion ${summary.tokens.completion} tokens`)
  }
  if (summary.intervention) {
    const iv = summary.intervention
    console.log(`干预后首次 talk_to 尝试：${iv.firstSocialAttemptMin === null ? '无' : `${iv.firstSocialAttemptMin} 分钟后`}；2 小时内社交类动作 ${iv.socialActionsWithin2h} 个`)
  }
  if (integrity) {
    const report = integrity.verify()
    const kinds = new Map<string, number>()
    for (const r of integrity.ledger.records()) {
      const k = r.kind.startsWith('audit.') ? 'audit.*' : r.kind
      kinds.set(k, (kinds.get(k) ?? 0) + 1)
    }
    console.log(
      `完整性账本：${integrity.ledger.size} 条（${[...kinds].map(([k, n]) => `${k}×${n}`).join('  ')}）；` +
        `核对${report.ok ? '通过' : `未通过：${JSON.stringify(report)}`}`,
    )
  }
  console.log(`产物：${outDir}`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
