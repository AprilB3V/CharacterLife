/**
 * Affordance · 此刻我能做什么？
 *
 * 可行动性来自多个扩展：世界（服务端动作清单 ∩ 角色信念上的「此地可做」）、
 * 对话（回应 / 协商 / 拒绝 / 等待 / 主动联系）……每个扩展登记一个 provider，
 * 内核只负责按登记顺序汇总成一份清单交给 Mind。
 *
 * 两条纪律：
 * 1. 清单是「可以提议什么」，不是「一定做得成什么」：成败永远由准入闸门与世界决定；
 * 2. provider 的内容来自服务端代码与已确认的观察，不来自模型输出或用户文本。
 */

export interface AffordanceOption {
  /** 渠道：world / conversation / 其它扩展名 */
  channel: string
  verb: string
  target: string | null
  label: string
  description: string
  /** 角色当前信念里此刻可做（世界由观察决定；对话类恒为 true） */
  believedAvailable: boolean
}

export type AffordanceProvider = () => AffordanceOption[]

export class AffordanceRegistry {
  #providers = new Map<string, AffordanceProvider>()

  /** 登记（同名覆盖）。返回注销函数。 */
  register(channel: string, provider: AffordanceProvider): () => void {
    this.#providers.set(channel, provider)
    return () => {
      if (this.#providers.get(channel) === provider) this.#providers.delete(channel)
    }
  }

  channels(): string[] {
    return [...this.#providers.keys()]
  }

  /** 汇总全部（或指定渠道的）可行动作，按登记顺序。 */
  list(channel?: string): AffordanceOption[] {
    const out: AffordanceOption[] = []
    for (const [name, provider] of this.#providers) {
      if (channel !== undefined && name !== channel) continue
      for (const option of provider()) out.push({ ...option, channel: name })
    }
    return out
  }
}
