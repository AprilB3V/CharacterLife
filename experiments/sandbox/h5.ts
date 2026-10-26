/**
 * H5 批量实验：内驱力干预是否因果地改变自主行为。
 *
 *   npm run sandbox:h5                         # RuleMind，零成本：验证实验管道本身
 *   npm run sandbox:h5 -- --mind deepseek      # 真实模型（需 DEEPSEEK_API_KEY），有调用上限
 *   npm run sandbox:h5 -- --seeds 20 --max-calls 800
 *
 * 设计（每个种子跑 4 次，世界安排在 4 次之间完全相同）：
 *   A 组：驱力不参与唤醒、Mind 看不到驱力      × {不干预, 12:00 把 social 设为 0.95}
 *   B 组：驱力参与唤醒、Mind 看得到驱力        × {不干预, 同上}
 *
 * 度量：从 12:00 起第一次尝试 talk_to 要等多久、2 小时内登记几个 talk_to。
 * 可证伪的预测：B 组干预显著提前/增加社交；A 组干预几乎没有影响。
 *
 * 注意：RuleMind 的决策规则本身就读驱力，所以它在 B 组"通过"是构造使然，
 * **不能**作为 H5 的证据。RuleMind 跑这个脚本的意义是确认实验管道、干预与
 * 度量都正确；真正的检验要用 LLM Mind。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DeepSeekProvider } from '../../src/conversation/providers/deepseek.ts'
import { LlmMind } from '../../src/autonomy/llm-mind.ts'
import { RecordingProvider } from '../../src/autonomy/replay.ts'
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/types.ts'
import type { AutonomyLogRecord } from '../../src/autonomy/runner.ts'
import { HOUR } from '../../src/util/clock.ts'
import type { Condition } from './scenario.ts'
import { createSandbox, runSandbox } from './scenario.ts'
import { socialWindow } from './summary.ts'

const INTERVENTION = { atSim: 12 * HOUR, drive: 'social', value: 0.95 }

/** 硬上限：超过就抛错停下，防止一次实验花掉意料之外的钱。 */
class CallBudget implements LLMProvider {
  used = 0
  #inner: LLMProvider
  #max: number
  constructor(inner: LLMProvider, max: number) {
    this.#inner = inner
    this.#max = max
  }
  get name(): string {
    return this.#inner.name
  }
  get model(): string {
    return this.#inner.model
  }
  async complete(request: LLMRequest): Promise<LLMResponse> {
    if (this.used >= this.#max) throw new Error(`已达调用上限 ${this.#max}，实验中止`)
    this.used += 1
    return this.#inner.complete(request)
  }
}

interface Cell {
  seed: number
  condition: Condition
  intervened: boolean
  firstSocialAttemptMin: number | null
  socialActionsWithin2h: number
  wakes: number
}

function parse(argv: string[]): { mind: 'rule' | 'deepseek'; seeds: number; maxCalls: number; hours: number } {
  const out = { mind: 'rule' as 'rule' | 'deepseek', seeds: 10, maxCalls: 800, hours: 7 }
  for (let i = 0; i < argv.length; i += 2) {
    const [k, v] = [argv[i], argv[i + 1]]
    if (k === '--mind' && (v === 'rule' || v === 'deepseek')) out.mind = v
    else if (k === '--seeds') out.seeds = Number.parseInt(v ?? '', 10)
    else if (k === '--max-calls') out.maxCalls = Number.parseInt(v ?? '', 10)
    else if (k === '--hours') out.hours = Number(v)
    else throw new Error(`未知参数 ${k}`)
  }
  return out
}

function mean(xs: number[]): number | null {
  return xs.length === 0 ? null : Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2))
  let budget: CallBudget | null = null
  let recorder: RecordingProvider | null = null
  if (args.mind === 'deepseek') {
    const key = process.env.DEEPSEEK_API_KEY
    if (!key) {
      console.log('未检测到 DEEPSEEK_API_KEY：跳过真实模型实验（这不是失败）。')
      return
    }
    recorder = new RecordingProvider(
      new DeepSeekProvider({ apiKey: key, baseUrl: process.env.DEEPSEEK_BASE_URL, model: process.env.DEEPSEEK_MODEL }),
    )
    budget = new CallBudget(recorder, args.maxCalls)
  }

  const cells: Cell[] = []
  for (let seed = 1; seed <= args.seeds; seed++) {
    for (const condition of ['A', 'B'] as const) {
      for (const intervened of [false, true]) {
        const records: AutonomyLogRecord[] = []
        const sb = createSandbox({
          seed,
          condition,
          mind: budget ? new LlmMind({ provider: budget }) : undefined,
          logger: (r) => records.push(r),
        })
        await runSandbox(sb, { hours: args.hours, intervention: intervened ? INTERVENTION : null })
        const w = socialWindow(records, INTERVENTION.atSim)
        cells.push({ seed, condition, intervened, ...w, wakes: sb.runner.wakes })
        process.stdout.write('.')
      }
    }
  }
  console.log('')

  const rows: string[] = []
  const table: Array<Record<string, unknown>> = []
  for (const condition of ['A', 'B'] as const) {
    for (const intervened of [false, true]) {
      const group = cells.filter((c) => c.condition === condition && c.intervened === intervened)
      const firsts = group.map((c) => c.firstSocialAttemptMin).filter((x): x is number => x !== null)
      const row = {
        condition,
        intervened,
        runs: group.length,
        socialWithin2h_mean: mean(group.map((c) => c.socialActionsWithin2h)),
        runsWithSocialWithin2h: group.filter((c) => c.socialActionsWithin2h > 0).length,
        firstSocialMin_mean: mean(firsts),
        wakes_mean: mean(group.map((c) => c.wakes)),
      }
      table.push(row)
      rows.push(
        `| ${condition} | ${intervened ? '是' : '否'} | ${row.runs} | ${row.runsWithSocialWithin2h}/${row.runs} | ${row.socialWithin2h_mean ?? '-'} | ${row.firstSocialMin_mean ?? '（无）'} | ${row.wakes_mean} |`,
      )
    }
  }

  // 配对差：同一种子、同一组，干预 − 不干预
  const paired = (condition: Condition): number[] =>
    Array.from({ length: args.seeds }, (_, i) => i + 1).map((seed) => {
      const on = cells.find((c) => c.seed === seed && c.condition === condition && c.intervened)!
      const off = cells.find((c) => c.seed === seed && c.condition === condition && !c.intervened)!
      return on.socialActionsWithin2h - off.socialActionsWithin2h
    })
  const dA = paired('A')
  const dB = paired('B')

  const md = [
    `# H5 内驱力干预实验（Mind = ${args.mind}）`,
    '',
    `- 种子：1..${args.seeds}；每个种子 4 次运行（A/B × 干预/不干预），世界安排在 4 次之间相同`,
    `- 时段：Day1 08:00 起 ${args.hours} 小时；干预：12:00 把 social 设为 0.95`,
    '- 度量窗口：12:00–14:00（社交动作 = 被准入的 talk_to）',
    args.mind === 'rule'
      ? '- **RuleMind 的规则直接读取驱力，B 组的差异是构造使然，不构成 H5 证据；本表只用于验证实验管道。**'
      : `- 模型调用：${budget?.used ?? 0} 次（上限 ${args.maxCalls}）`,
    '',
    '| 组 | 干预 | 运行数 | 2h 内有社交的运行 | 2h 内社交动作均值 | 首次社交（分钟，均值） | 唤醒次数均值 |',
    '|---|---|---|---|---|---|---|',
    ...rows,
    '',
    `配对差（干预 − 不干预，2h 内社交动作数）：A 组均值 ${mean(dA)}，B 组均值 ${mean(dB)}`,
    '',
    '判读：B 组配对差显著大于 0、而 A 组接近 0 → 支持 H5；B 组与 A 组无差别 → H5 被推翻（驱力只是装饰）。',
  ].join('\n')

  const outDir = join(process.cwd(), 'experiments', 'sandbox', '.data', `h5-${args.mind}`)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, 'cells.json'), JSON.stringify(cells, null, 2), 'utf8')
  writeFileSync(join(outDir, 'table.json'), JSON.stringify(table, null, 2), 'utf8')
  writeFileSync(join(outDir, 'report.md'), md + '\n', 'utf8')
  if (recorder) writeFileSync(join(outDir, 'calls.json'), JSON.stringify(recorder.calls), 'utf8')
  console.log(md)
  console.log(`\n产物：${outDir}`)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
