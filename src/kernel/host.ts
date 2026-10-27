/**
 * AgentHost：一个世界里托管多个角色（V0.5 · 通用骨架）。
 *
 * 只做三件与具体玩法无关的事：
 *   1. 共享一个模拟时钟，按固定步长推进；
 *   2. 每一步先让世界推进（结算动作、产生观察），再让每个角色依次走一遍自主循环；
 *   3. 角色的先后顺序是确定的（固定或轮转），同一种子 + 同一 Mind 输出 → 同一份日志。
 *
 * 胜负、回合、谁能听见谁说话 —— 这些都是**世界的规则**，由世界驱动（WorldDriver）实现，
 * 不写进内核。Free Roam 的斗场「宪法」会作为一个 WorldDriver 接进来。
 */

import type { AutonomyRunner } from './cycle/runner.ts'

/** 世界一侧：每个调度步推进一次（结算、变化、领取动作、上报回执与观察）。 */
export interface WorldDriver {
  step(): void
}

export interface SteppableClock {
  nowSim(): number
  advance(ms: number): void
}

export interface AgentHostOptions {
  clock: SteppableClock
  /** 调度步长（模拟毫秒），默认 5 分钟 */
  tickMs?: number
  /**
   * 角色顺序：fixed = 每步都按登记顺序；rotate = 每步把起点后移一位，
   * 避免某个角色永远先手（是否需要由世界规则决定）。
   */
  order?: 'fixed' | 'rotate'
}

export interface HostHooks {
  /** 世界推进之后、角色行动之前（实验干预、导演事件在这里注入） */
  beforeAgents?: (nowSim: number) => void
  /** 本步所有角色行动之后 */
  afterAgents?: (nowSim: number) => void
}

export class AgentHost {
  #clock: SteppableClock
  #tickMs: number
  #order: 'fixed' | 'rotate'
  #worlds: WorldDriver[] = []
  #agents: Array<{ id: string; runner: AutonomyRunner }> = []
  #tick = 0

  constructor(opts: AgentHostOptions) {
    this.#clock = opts.clock
    this.#tickMs = opts.tickMs ?? 5 * 60_000
    this.#order = opts.order ?? 'fixed'
  }

  addWorld(world: WorldDriver): this {
    this.#worlds.push(world)
    return this
  }

  addAgent(id: string, runner: AutonomyRunner): this {
    if (this.#agents.some((a) => a.id === id)) throw new Error(`角色 ${id} 已登记`)
    this.#agents.push({ id, runner })
    return this
  }

  get agentIds(): string[] {
    return this.#agents.map((a) => a.id)
  }

  get ticks(): number {
    return this.#tick
  }

  /** 本步的角色顺序。 */
  orderFor(tick: number): string[] {
    const ids = this.agentIds
    if (this.#order === 'fixed' || ids.length === 0) return ids
    const k = tick % ids.length
    return [...ids.slice(k), ...ids.slice(0, k)]
  }

  /** 推进一步：世界 → 钩子 → 角色（按顺序）→ 钩子 → 时钟前进。 */
  async tick(hooks: HostHooks = {}): Promise<void> {
    for (const world of this.#worlds) world.step()
    const now = this.#clock.nowSim()
    hooks.beforeAgents?.(now)
    for (const id of this.orderFor(this.#tick)) {
      const entry = this.#agents.find((a) => a.id === id)!
      await entry.runner.step()
    }
    hooks.afterAgents?.(now)
    this.#tick += 1
    this.#clock.advance(this.#tickMs)
  }

  /** 连续推进一段模拟时间。 */
  async run(durationMs: number, hooks: HostHooks = {}): Promise<void> {
    for (const { runner } of this.#agents) runner.start()
    const end = this.#clock.nowSim() + durationMs
    while (this.#clock.nowSim() < end) await this.tick(hooks)
  }
}
