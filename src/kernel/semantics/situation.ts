/**
 * Situation · 我处于什么处境？
 *
 * 角色视角的**信念**，由观察推出，不是世界真值的镜像：
 * 它只在收到新的观察时更新，中间可能过时 —— 面包在角色不在场时卖完了，
 * 它的处境里仍然写着「面包房能买面包」，直到它去了、失败了、看见了。
 *
 * 通用字段（位置、在场者、可做的事、随身物品）覆盖箱庭与斗场的常见需要；
 * 其它世界特有的事实放进 `facts`。
 */

import type { Percept } from './observation.ts'

export interface Situation {
  /** 这份信念来自哪个时刻的观察；从未观察过为 null */
  asOfSim: number | null
  location: string | null
  present: string[]
  /** 世界最近一次告诉角色「这里能做」的动作，形如 `buy(bread)` */
  affords: string[]
  inventory: Record<string, number>
  /** 其它标量事实（最近一次观察到的值） */
  facts: Record<string, string | number | boolean>
}

export function emptySituation(): Situation {
  return { asOfSim: null, location: null, present: [], affords: [], inventory: {}, facts: {} }
}

const RESERVED = new Set(['snapshot', 'location', 'present', 'affords', 'event'])

function values(p: Pick<Percept, 'facts'>, key: string): Array<string | number | boolean> {
  return p.facts.filter((f) => f.key === key).map((f) => f.value)
}

/**
 * 把一条感知并入处境信念（纯函数）。
 *
 * 事实约定（与 docs/AUTONOMY.md §5 一致）：
 *   `snapshot=true` 时 present / affords 整体替换；否则保持原信念；
 *   `location` 取最后一个值；`inventory.<item>` 为数量；其余 key 写进 facts。
 */
export function applyPercept(prev: Situation, p: Pick<Percept, 'facts' | 'atSim'>): Situation {
  const next: Situation = {
    asOfSim: p.atSim,
    location: prev.location,
    present: [...prev.present],
    affords: [...prev.affords],
    inventory: { ...prev.inventory },
    facts: { ...prev.facts },
  }
  const location = values(p, 'location')
  if (location.length > 0) next.location = String(location[location.length - 1])
  if (values(p, 'snapshot').some((v) => v === true)) {
    next.present = values(p, 'present').map(String)
    next.affords = values(p, 'affords').map(String)
  }
  for (const f of p.facts) {
    if (f.key.startsWith('inventory.') && typeof f.value === 'number') {
      next.inventory[f.key.slice('inventory.'.length)] = f.value
    } else if (!RESERVED.has(f.key)) {
      next.facts[f.key] = f.value
    }
  }
  return next
}

export class SituationStore {
  #current: Situation = emptySituation()

  current(): Situation {
    return structuredClone(this.#current)
  }

  apply(p: Pick<Percept, 'facts' | 'atSim'>): Situation {
    this.#current = applyPercept(this.#current, p)
    return this.current()
  }
}
