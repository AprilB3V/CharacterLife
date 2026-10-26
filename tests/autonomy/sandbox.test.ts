/**
 * 文字箱庭端到端（V0.4 · E0）：整条自主管道，零模型调用。
 *
 * 断言重点：
 * - 同一种子、同一 Mind → 逐字节相同的日志（可复现）；
 * - B 组会因饥饿去买面包并吃到；A 组看不到驱力，不会去吃；
 * - H5 干预：B 组把 social 调高后，社交提前出现；A 组不受影响（管道层面的因果检验）；
 * - 角色在动作执行中不会被唤醒；唤醒次数受每小时预算约束；
 * - LLM Mind：清单外动作被闸门拒绝且不会执行；输出解析失败降级为不行动；
 * - 录制/回放：回放与原运行一致；输入变化时回放明确失败。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HOUR } from '../../src/kernel/util/clock.ts'
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/types.ts'
import type { AutonomyLogRecord } from '../../src/kernel/cycle/runner.ts'
import { LlmMind, parseMindOutput } from '../../src/kernel/cycle/llm-mind.ts'
import { RecordingProvider, ReplayMismatchError, ReplayProvider } from '../../src/kernel/cycle/replay.ts'
import { createSandbox, runSandbox } from '../../experiments/sandbox/scenario.ts'
import type { Condition } from '../../experiments/sandbox/scenario.ts'
import { socialWindow } from '../../experiments/sandbox/summary.ts'

async function run(opts: {
  seed?: number
  condition?: Condition
  hours?: number
  intervention?: { atSim: number; drive: string; value: number } | null
  provider?: LLMProvider
}): Promise<{ records: AutonomyLogRecord[]; sb: ReturnType<typeof createSandbox> }> {
  const records: AutonomyLogRecord[] = []
  const sb = createSandbox({
    seed: opts.seed ?? 1,
    condition: opts.condition ?? 'B',
    mind: opts.provider ? new LlmMind({ provider: opts.provider }) : undefined,
    logger: (r) => records.push(r),
  })
  await runSandbox(sb, { hours: opts.hours ?? 10, intervention: opts.intervention ?? null })
  return { records, sb }
}

const wakes = (records: AutonomyLogRecord[]) =>
  records.filter((r): r is Extract<AutonomyLogRecord, { type: 'wake' }> => r.type === 'wake')
const outcomes = (records: AutonomyLogRecord[]) =>
  records.filter((r): r is Extract<AutonomyLogRecord, { type: 'outcome' }> => r.type === 'outcome')

/** 按脚本回答的假模型（不联网、零成本）。 */
class ScriptedProvider implements LLMProvider {
  readonly name = 'scripted'
  readonly model = 'scripted-v1'
  calls = 0
  #answers: string[]
  constructor(answers: string[]) {
    this.#answers = answers
  }
  async complete(_request: LLMRequest): Promise<LLMResponse> {
    const text = this.#answers[this.calls % this.#answers.length]!
    this.calls += 1
    return { text, provider: this.name, model: this.model, usage: { promptTokens: 10, completionTokens: 5 }, latencyMs: 0 }
  }
}

describe('箱庭 · 规则 Mind', () => {
  it('同一种子 → 逐字节相同的日志', async () => {
    const a = await run({ seed: 3 })
    const b = await run({ seed: 3 })
    assert.equal(JSON.stringify(a.records), JSON.stringify(b.records))
    assert.equal(JSON.stringify(a.sb.town.truth), JSON.stringify(b.sb.town.truth))
  })

  it('B 组：饿了会去买面包并吃到；A 组看不到驱力，不会去吃', async () => {
    const b = await run({ condition: 'B' })
    assert.ok(outcomes(b.records).some((o) => o.action === 'eat(bread)' && o.status === 'succeeded'))
    const ate = outcomes(b.records).find((o) => o.action === 'eat(bread)')!
    assert.deepEqual(ate.driveChanges.map((c) => c.path), ['drives.hunger'])

    const a = await run({ condition: 'A' })
    assert.equal(outcomes(a.records).some((o) => o.action === 'eat(bread)'), false)
  })

  it('H5 管道：干预 social 让 B 组更早去社交；A 组不受影响', async () => {
    const iv = { atSim: 12 * HOUR, drive: 'social', value: 0.95 }
    const bOff = socialWindow((await run({ condition: 'B', hours: 7 })).records, iv.atSim)
    const bOn = socialWindow((await run({ condition: 'B', hours: 7, intervention: iv })).records, iv.atSim)
    assert.ok(bOn.socialActionsWithin2h > bOff.socialActionsWithin2h)

    const aOff = socialWindow((await run({ condition: 'A', hours: 7 })).records, iv.atSim)
    const aOn = socialWindow((await run({ condition: 'A', hours: 7, intervention: iv })).records, iv.atSim)
    assert.deepEqual(aOn, aOff)
  })

  it('动作执行中不唤醒：每次唤醒时都没有自己的未结算动作', async () => {
    const { records } = await run({})
    let inFlight = 0
    for (const r of records) {
      if (r.type === 'wake') {
        assert.equal(inFlight, 0, `${r.clock} 在动作执行中被唤醒`)
        if (r.admission?.ok) inFlight += 1
      }
      if (r.type === 'outcome') inFlight = Math.max(0, inFlight - 1)
    }
  })

  it('世界记忆都来自 runtime_event，且都能追溯到世界事件', async () => {
    const { sb } = await run({ hours: 6 })
    const mem = sb.agent.memory.list({ tags: ['world'] })
    assert.ok(mem.length > 0)
    for (const m of mem) {
      assert.equal(m.origin, 'runtime_event')
      assert.match(m.sourceRef ?? '', /^tw_\d+$/)
    }
  })
})

describe('箱庭 · LLM Mind（脚本化，零成本）', () => {
  it('清单外的动作被闸门拒绝，世界不会执行', async () => {
    const provider = new ScriptedProvider(['{"thought":"试试","action":{"verb":"destroy","target":"world","reason":"x"}}'])
    const { records } = await run({ provider, hours: 2 })
    const w = wakes(records)
    assert.ok(w.length > 0)
    for (const r of w) {
      assert.equal(r.admission?.ok, false)
      if (r.admission && !r.admission.ok) assert.equal(r.admission.code, 'VERB_NOT_ALLOWED')
    }
    assert.equal(outcomes(records).length, 0)
  })

  it('输出解析失败 → 不行动、记录错误，模拟继续', async () => {
    const provider = new ScriptedProvider(['这不是 JSON'])
    const { records } = await run({ provider, hours: 2 })
    const w = wakes(records)
    assert.ok(w.length >= 1)
    assert.ok(w.every((r) => r.action === null && r.error === 'json_parse_failed'))
  })

  it('唤醒（= 模型调用）受每小时预算约束', async () => {
    // 每次都选一个会被世界立刻拒绝的动作：outcome 唤醒会非常频繁，只有预算能挡住
    const provider = new ScriptedProvider(['{"thought":"","action":{"verb":"browse","target":"stall","reason":"x"}}'])
    const { records } = await run({ provider, hours: 3 })
    const times = wakes(records).map((r) => r.t)
    for (const t of times) {
      assert.ok(times.filter((x) => x > t - HOUR && x <= t).length <= 6)
    }
    assert.equal(provider.calls, times.length)
  })

  it('parseMindOutput 容忍代码块包裹，拒绝缺 verb 的动作', () => {
    const ok = parseMindOutput('```json\n{"thought":"嗯","action":{"verb":"rest","target":"bed"}}\n```')
    assert.equal(ok.action?.verb, 'rest')
    assert.equal(parseMindOutput('{"thought":"","action":{"target":"bed"}}').error, 'action_missing_verb')
    assert.equal(parseMindOutput('{"thought":"","action":null}').action, null)
  })
})

describe('箱庭 · 录制与回放', () => {
  const ANSWERS = [
    '{"thought":"修书","action":{"verb":"repair","target":"old_book","reason":"手上的活"}}',
    '{"thought":"去面包房","action":{"verb":"move_to","target":"bakery","reason":"饿"}}',
    '{"thought":"买","action":{"verb":"buy","target":"bread","reason":"饿"}}',
    '{"thought":"吃","action":{"verb":"eat","target":"bread","reason":"饿"}}',
  ]

  it('回放与原运行逐字节一致', async () => {
    const recorder = new RecordingProvider(new ScriptedProvider(ANSWERS))
    const original = await run({ provider: recorder, hours: 4 })
    assert.ok(recorder.calls.length > 0)
    const replay = await run({ provider: new ReplayProvider(recorder.calls), hours: 4 })
    // Mind 名称会如实标出 replay；除此之外每一条记录都应相同
    const strip = (rs: AutonomyLogRecord[]) =>
      JSON.stringify(rs.map((r) => (r.type === 'wake' || r.type === 'start' ? { ...r, mind: '-', ...(r.type === 'wake' ? { latencyMs: 0 } : {}) } : r)))
    assert.equal(strip(replay.records), strip(original.records))
  })

  it('输入变了（换种子影响世界）→ 回放明确失败，而不是悄悄给出不同结果', async () => {
    const recorder = new RecordingProvider(new ScriptedProvider(ANSWERS))
    await run({ provider: recorder, hours: 4, seed: 1 })
    await assert.rejects(
      run({ provider: new ReplayProvider(recorder.calls), hours: 4, seed: 1, condition: 'A' }),
      ReplayMismatchError,
    )
  })
})
