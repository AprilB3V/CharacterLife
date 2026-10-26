/**
 * 世界 → 角色认知的受控桥（V0.4）。
 *
 * 第一阶段的硬约束是「世界事件不得变成记忆或状态提议」，那是为了在没有
 * 自主运行的时候不留任何外部写入口。V0.4 有了自主轮次，角色必须能记住
 * 自己做过什么、看见过什么，于是在这里开一个**受控**的口子：
 *
 * 1. 桥放在 `src/autonomy/`，`src/world/` 依旧不引用 workspace / memory / runtime，
 *    依赖方向不变（世界模块无法改写角色状态，这一条仍然是结构保证）；
 * 2. 只有**已结算**的动作才写记忆：
 *      succeeded / failed / rejected → `fact`（世界确认过的成功或失败）
 *      expired 且从未派发           → `fact`「没有发生」
 *      expired 但派发过             → `speculation`「可能做了，结果不明」
 *    pending / dispatched 一律不写 —— 意图不是经历；
 * 3. 记忆来源固定为 `runtime_event`（唯一能打 `world` 保留标签的来源），
 *    `sourceRef` 指向世界事件 id，任何一条世界记忆都能追溯到回执；
 * 4. 驱力只在 `succeeded` 时被缓解；失败的动作不会让角色"感觉吃过了"；
 * 5. 世界错误码 `code` 不进记忆正文（与 observation.ts 同一口径）；
 *    世界自由文本 `summary` 可以进记忆，但记忆永远只在数据区出现。
 *
 * V0.5 起，桥只做「世界 → 内核语义槽」的翻译：结算写 Memory、缓解写 Motivation，
 * 观察写 Observation 并更新 Situation，自己不再保存任何角色状态。
 *
 * 观察事件（`kind=observation`）分两类处理：
 *   - 全部用于更新 **Situation**（角色视角的信念，不是世界真值的镜像：
 *     它只在收到下一条观察时才更新，中间可能过时）；
 *   - 只有带 `event` 事实的观察（有人来了、摊位开了、面包卖完了）才算显著，
 *     写成情景记忆并作为唤醒原因。例行快照不进长期记忆，避免记忆被流水账淹没。
 */

import type { AgentCore } from '../agent.ts'
import { RUNTIME_ACTOR } from '../policy/policy.ts'
import type { WorldService } from '../world/service.ts'
import type { WorldActionView } from '../world/contracts.ts'
import { narrationFor } from '../world/state.ts'
import type { IdFactory } from '../util/ids.ts'
import { satisfactionProposals } from '../semantics/drives.ts'
import type { Situation } from '../semantics/situation.ts'

export interface SettledOutcome {
  actionId: string
  verb: string
  target: string | null
  status: WorldActionView['status']
  /** 记忆里的认识论状态：fact 或 speculation */
  epistemic: 'fact' | 'speculation'
  memoryId: string | null
  driveChanges: Array<{ path: string; value: unknown }>
  atSim: number
}

export interface SalientNote {
  observationSeq: number
  eventId: string
  /** 机器可读事件标签，例如 `npc_arrived:npc_lin` */
  events: string[]
  memoryId: string | null
}

export interface BridgeSync {
  outcomes: SettledOutcome[]
  salient: SalientNote[]
  observationsApplied: number
  situation: Situation
}

export interface WorldBridgeOptions {
  /** 角色内核：结算写进它的 Memory / Motivation，观察写进它的 Observation / Situation */
  agent: AgentCore
  world: WorldService
  instanceId: string
  ids: IdFactory
  /** 动作的中文标签（来自服务端目录），只用于记忆标题的可读性 */
  labelFor?: (verb: string, target: string | null) => string
}

const RESULT_TEXT: Record<string, string> = {
  succeeded: '成功',
  failed: '失败',
  rejected: '被世界拒绝',
}

function factValues(record: { facts: Array<{ key: string; value: string | number | boolean }> }, key: string): Array<string | number | boolean> {
  return record.facts.filter((f) => f.key === key).map((f) => f.value)
}

export class WorldBridge {
  #ws: AgentCore
  #world: WorldService
  #instanceId: string
  #ids: IdFactory
  #labelFor: (verb: string, target: string | null) => string
  #seen = new Set<string>()
  #cursor = 0

  constructor(opts: WorldBridgeOptions) {
    this.#ws = opts.agent
    this.#world = opts.world
    this.#instanceId = opts.instanceId
    this.#ids = opts.ids
    this.#labelFor = opts.labelFor ?? ((verb, target) => `${verb}(${target ?? '*'})`)
  }

  /** 角色的处境信念（就是内核 Situation 槽的当前值）。 */
  get situation(): Situation {
    return this.#ws.situation.current()
  }

  /** 自己是否还有未结算的动作（pending / dispatched）。 */
  actionInFlight(): boolean {
    return this.#world
      .list({ instanceId: this.#instanceId })
      .some((a) => a.status === 'pending' || a.status === 'dispatched')
  }

  /**
   * 把世界侧新的结算与观察同步进角色认知。幂等：重复调用不会重复写入。
   */
  sync(): BridgeSync {
    const outcomes: SettledOutcome[] = []
    for (const action of this.#world.list({ instanceId: this.#instanceId })) {
      if (this.#seen.has(action.actionId)) continue
      if (action.status === 'pending' || action.status === 'dispatched') continue
      this.#seen.add(action.actionId)
      outcomes.push(this.#settle(action))
    }

    const salient: SalientNote[] = []
    const observations = this.#world.observations(this.#instanceId, this.#cursor)
    for (const obs of observations) {
      this.#cursor = Math.max(this.#cursor, obs.seq)
      const events = factValues(obs, 'event').map(String)
      // Observation 槽记下感知；Situation 槽据此更新信念
      const percept = this.#ws.observation.append({
        atSim: obs.receivedAtSim,
        source: 'world',
        from: null,
        text: obs.summary,
        facts: obs.facts,
        events,
        ref: obs.eventId,
      })
      this.#ws.situation.apply(percept)
      if (events.length === 0) continue
      const written = this.#ws.writeMemory(
        {
          kind: 'episodic',
          title: `看见：${events.join('、')}`,
          content: obs.summary.length > 0 ? obs.summary : events.join('；'),
          status: 'fact',
          origin: 'runtime_event',
          salience: 0.55,
          tags: ['world', 'observation', ...events.map((e) => e.split(':')[0]!)],
        },
        RUNTIME_ACTOR,
        obs.eventId,
      )
      salient.push({ observationSeq: obs.seq, eventId: obs.eventId, events, memoryId: written.entryId })
    }

    return { outcomes, salient, observationsApplied: observations.length, situation: this.situation }
  }

  #settle(action: WorldActionView): SettledOutcome {
    const label = this.#labelFor(action.verb, action.target)
    const now = this.#world.nowSim()
    const narration = narrationFor({
      status: action.status,
      firstDispatchedAtSim: action.firstDispatchedAtSim,
    })

    let epistemic: 'fact' | 'speculation' = 'fact'
    let title: string
    let content: string
    let salience = 0.45
    if (action.status === 'expired') {
      if (narration === 'failed') {
        title = `没能${label}`
        content = `我想${label}，但这件事没有发生（世界没有领取这个动作）。`
      } else {
        epistemic = 'speculation'
        title = `${label}，结果不明`
        content = `我可能${label}了，但没有收到确认，不确定有没有做成。`
      }
      salience = 0.5
    } else {
      const resultText = RESULT_TEXT[action.status] ?? action.status
      title = `${label}${resultText}`
      const summary = action.outcome?.summary ?? ''
      content = summary.length > 0 ? summary : `${label}${resultText}。`
      // 失败比成功更"出乎预期"，更值得记住（备忘录 3.2：与原有预期的冲突程度）
      salience = action.status === 'succeeded' ? 0.4 : 0.65
    }

    const written = this.#ws.writeMemory(
      {
        kind: 'episodic',
        title,
        content,
        status: epistemic,
        origin: 'runtime_event',
        salience,
        tags: ['world', 'action', action.verb, action.status],
      },
      RUNTIME_ACTOR,
      action.outcome?.eventId ?? action.actionId,
    )

    let driveChanges: SettledOutcome['driveChanges'] = []
    const drives = this.#ws.motivation.driveProfile
    if (action.status === 'succeeded' && drives) {
      const proposals = satisfactionProposals({
        profile: drives,
        dynamic: this.#ws.dynamicState,
        verb: action.verb,
        target: action.target,
        atSim: now,
        evidence: action.outcome?.eventId ?? action.actionId,
        makeId: () => this.#ids.next('pr'),
      })
      if (proposals.length > 0) {
        const outcome = this.#ws.submitProposals(proposals, RUNTIME_ACTOR, { source: 'world_bridge' })
        driveChanges = outcome.applied.map((p) => ({ path: p.path, value: p.value }))
      }
    }

    return {
      actionId: action.actionId,
      verb: action.verb,
      target: action.target,
      status: action.status,
      epistemic,
      memoryId: written.entryId,
      driveChanges,
      atSim: now,
    }
  }
}
