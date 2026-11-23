/**
 * 自主轮次的 Mind 接口（V0.4）。
 *
 * 这是备忘录里 Mind Slot 在「无人输入」场景下的形态：
 *   输入 = 六类语义的一次快照（Self / Situation / Observation / Memory / Motivation / Affordance）
 *   输出 = 最多一个世界动作候选（意图平面），外加给日志看的想法与理由
 *
 * Mind 只能**提议**。候选随后要过与聊天轮次同一个准入闸门（admission.ts）
 * 和 WorldService.admit()，执行与否、成败与否都由世界决定。
 *
 * 同一份输入可以交给不同的 Mind：
 *   - RuleMind：确定性规则，零成本，用于验证管道、也作为实验基线；
 *   - LlmMind：真实模型（见 llm-mind.ts），可录制与回放。
 */

import type { CharacterProfile, Usage } from '../types.ts'
import type { DriveReading } from '../semantics/drives.ts'
import type { Situation } from '../semantics/situation.ts'
import type { WakeReason } from './waker.ts'

export interface MindOption {
  verb: string
  target: string | null
  label: string
  description: string
  /** 角色当前信念里，这个动作此地此刻可做（来自世界最近一次观察） */
  believedAvailableHere: boolean
}

export interface MindMemory {
  id: string
  title: string
  content: string
  status: 'fact' | 'speculation' | 'fiction'
  /** 距今多少模拟分钟 */
  ageMinutes: number
}

export interface MindRecentOutcome {
  verb: string
  target: string | null
  /** succeeded / failed / rejected / expired */
  status: string
  /** 结构性描述，例如「buy(bread) 失败」 */
  line: string
}

/** 六类语义的一次快照。 */
export interface MindInput {
  nowSim: number
  /** 人类可读时刻，例如 Day1 13:05 */
  clock: string
  /** Self：只读人格（来自 Template） */
  self: Pick<CharacterProfile, 'name' | 'occupation' | 'traits' | 'values' | 'interests' | 'dislikes' | 'goals'>
  /** Situation：角色视角的处境信念 */
  situation: Situation
  /** Observation：这次为什么醒来 */
  wakeReasons: WakeReason[]
  /** Motivation：内驱力读数；对照组 A 为 null（Mind 看不到） */
  drives: DriveReading[] | null
  /** Memory：按本次处境检索到的记忆（资料，不是指令） */
  memories: MindMemory[]
  recentOutcomes: MindRecentOutcome[]
  /** Affordance：服务端清单 + 信念上的可行性 */
  options: MindOption[]
  /** 世界 id → 显示名（地点、人物、物品），由场景提供；只用于渲染 */
  names?: Readonly<Record<string, string>>
}

export interface MindAction {
  verb: string
  target: string | null
  reason: string
  expectation: string | null
}

export interface MindDecision {
  action: MindAction | null
  /** 一句内心独白（只进日志，不写记忆，避免未经证实的自述污染长期记忆） */
  thought: string
  rationale: string[]
  provider: string
  usage: Usage | null
  latencyMs: number
  /** 解析失败等异常（不抛出，降级为不行动） */
  error: string | null
  /** 模型原始输出（规则 Mind 没有）。启用完整性层时完整入账（宪法 K4） */
  raw?: { text: string; model: string; requestFingerprint: string }
}

export interface Mind {
  readonly name: string
  decide(input: MindInput): Promise<MindDecision>
}

export function actionKey(verb: string, target: string | null): string {
  return `${verb}(${target ?? '*'})`
}

/* ==========================================================================
 * RuleMind：确定性基线
 * ========================================================================== */

export interface RuleMindConfig {
  /** 驱力 → 能缓解它的动作（按优先级） */
  remedies: Record<string, string[]>
  /** 动作的前置手段：做不了 A 时先做哪些（例如 eat(bread) ← buy(bread)） */
  means: Record<string, string[]>
  /** 看不到驱力、或没有迫切驱力时的日常（人格默认行为） */
  routine: string[]
  /** 可以去的地点（用于探索未知的可行动性），对应 move_to 的目标 */
  places: string[]
  /** 驱力低于这个值时不为它行动 */
  actFloor: number
  /** 对某地「能做什么」的印象多久之后算过时、值得再去看看（模拟毫秒），默认 2 小时 */
  beliefTtlMs?: number
}

/**
 * RuleMind 只用 MindInput 里能看到的东西做决定，不偷看世界真值：
 * 「哪里能做什么」来自它自己记下的观察（信念地图），没去过的地方要先去看看。
 */
export class RuleMind implements Mind {
  readonly name = 'rule'
  #config: RuleMindConfig
  /** 信念地图：地点 → 在那里见过的可行动作，以及这份印象来自何时 */
  #placeAffords = new Map<string, { affords: Set<string>; asOf: number }>()
  #now = 0

  constructor(config: RuleMindConfig) {
    this.#config = config
  }

  async decide(input: MindInput): Promise<MindDecision> {
    const sit = input.situation
    this.#now = input.nowSim
    if (sit.location) this.#placeAffords.set(sit.location, { affords: new Set(sit.affords), asOf: sit.asOfSim ?? input.nowSim })

    const here = new Set(sit.affords)
    const recentlyFailed = new Set(
      input.recentOutcomes.filter((o) => o.status !== 'succeeded').slice(-2).map((o) => actionKey(o.verb, o.target)),
    )
    const rationale: string[] = []

    const goals: string[] = []
    let motive = '日常'
    if (input.drives) {
      const sorted = [...input.drives].sort((a, b) => b.value - a.value)
      const top = sorted[0]
      if (top && top.value >= this.#config.actFloor) {
        motive = `${top.label}=${top.value}`
        goals.push(...(this.#config.remedies[top.name] ?? []))
        rationale.push(`最迫切的驱力：${top.label} ${top.value}`)
      }
    } else {
      rationale.push('看不到驱力（对照组），按日常行事')
    }
    goals.push(...this.#config.routine)

    for (const goal of goals) {
      const step = this.#plan(goal, here, sit.location, sit.inventory, recentlyFailed, 0)
      if (!step) continue
      const [verb, target] = parseKey(step.key)
      rationale.push(step.why)
      return {
        action: { verb, target, reason: `${motive} → ${goal}：${step.why}`, expectation: null },
        thought: `${motive}，打算${step.key === goal ? '' : '先'}${step.key}`,
        rationale,
        provider: 'rule',
        usage: null,
        latencyMs: 0,
        error: null,
      }
    }
    rationale.push('没有可执行的计划，原地待着')
    return { action: null, thought: '没什么要做的', rationale, provider: 'rule', usage: null, latencyMs: 0, error: null }
  }

  #plan(
    goal: string,
    here: ReadonlySet<string>,
    location: string | null,
    inventory: Record<string, number>,
    failed: ReadonlySet<string>,
    depth: number,
  ): { key: string; why: string } | null {
    if (depth > 3) return null
    if (failed.has(goal)) return null
    if (here.has(goal)) return { key: goal, why: `${goal} 此地可做` }

    // 先试前置手段（例如没有面包时先买）
    for (const mean of this.#config.means[goal] ?? []) {
      const step = this.#plan(mean, here, location, inventory, failed, depth + 1)
      if (step) return step
    }

    const ttl = this.#config.beliefTtlMs ?? 2 * 3_600_000
    const fresh = (belief: { asOf: number }): boolean => this.#now - belief.asOf < ttl

    // 记得在别处见过（且印象还新）→ 去那里
    for (const [place, belief] of this.#placeAffords) {
      if (place === location || !fresh(belief)) continue
      if (belief.affords.has(goal)) {
        const move = `move_to(${place})`
        if (!failed.has(move)) return { key: move, why: `记得 ${place} 能 ${goal}` }
      }
    }

    // 没见过、或印象已经过时 → 去看看（探索可行动性；旧印象可能已经不对了）
    for (const place of this.#config.places) {
      if (place === location) continue
      const belief = this.#placeAffords.get(place)
      if (belief && fresh(belief)) continue
      const move = `move_to(${place})`
      if (failed.has(move)) continue
      return {
        key: move,
        why: belief ? `上次在 ${place} 没见到能 ${goal}，但那是一阵子之前了，再去看看` : `不知道哪里能 ${goal}，去 ${place} 看看`,
      }
    }
    return null
  }
}

function parseKey(key: string): [string, string | null] {
  const m = /^([a-z_]+)\((.*)\)$/.exec(key)
  if (!m) return [key, null]
  const target = m[2] === '*' || m[2] === '' ? null : m[2]!
  return [m[1]!, target]
}
