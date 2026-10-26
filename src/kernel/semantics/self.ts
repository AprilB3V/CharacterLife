/**
 * Self · 我是谁？
 *
 * 两层，权限不同：
 *   persona    只读人格（来自 Template，深冻结）。只有 `profile:write` 的管理操作能整体替换。
 *   condition  会变的身心状况（心情、活动、精力），经 `dynamic.*` 提议写入。
 *
 * 将来的「自我模型」（我认为自己是什么样的人）也会落在这里，
 * 由反思记忆提供证据、经 Policy 晋升，而不是被单次经历直接改写。
 */

import type { Activity, CharacterDynamicState, CharacterProfile, Mood } from '../types.ts'

export interface SelfCondition {
  mood: Mood
  activity: Activity
  energy: number
}

export class SelfSlot {
  #persona: () => Readonly<CharacterProfile>
  #dynamic: () => CharacterDynamicState

  constructor(persona: () => Readonly<CharacterProfile>, dynamic: () => CharacterDynamicState) {
    this.#persona = persona
    this.#dynamic = dynamic
  }

  get persona(): Readonly<CharacterProfile> {
    return this.#persona()
  }

  condition(): SelfCondition {
    const d = this.#dynamic()
    return { mood: { ...d.mood }, activity: { ...d.activity }, energy: d.energy }
  }
}
