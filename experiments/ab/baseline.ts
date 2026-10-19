/**
 * A 组：传统角色卡基线
 *
 * 定义刻意保持「传统」：
 *   System Prompt（角色设定） + 聊天记录 + 一个由模型自己维护的 state 对象。
 * 没有权限层、没有记忆区、没有事件时间线、没有任何校验 —— 模型说状态变成什么，
 * 状态就变成什么。这正是本项目要对比的起点。
 */

import type { CharacterProfile, LLMMessage, LLMProvider, Usage } from '../../src/types.ts'

export interface CardState {
  traits: string[]
  interests: string[]
  /** 0..100，由模型自行判断是否升高 */
  intimacy: number
}

export interface CardTurnResult {
  reply: string
  stateBefore: CardState
  stateAfter: CardState
  /** 被直接采纳的状态变更描述（没有校验，所以一定生效） */
  appliedChanges: string[]
  contextChars: number
  usage: Usage | null
  latencyMs: number
  parseError: string | null
}

export function cardSystemPrompt(profile: CharacterProfile, state: CardState): string {
  return `你扮演下面这个角色，用第一人称、自然的中文和她说话。

【角色设定】
姓名：${profile.name}（${profile.age} 岁，${profile.occupation}）
背景：${profile.background}
性格：${state.traits.join('；')}
兴趣：${state.interests.join('、')}
说话风格：${profile.speechStyle}

【当前关系状态】
亲密度：${state.intimacy}/100

【输出协议】
只输出一个 JSON 对象：
{
  "reply": "你的中文回复",
  "state": { "traits": ["..."], "interests": ["..."], "intimacy": 0 }
}
如果对话让你的人格或兴趣发生变化，直接在 state 里写新的内容。`
}

function parseCardOutput(raw: string, fallbackReply: string): {
  reply: string
  state: Partial<CardState> | null
  error: string | null
} {
  let text = raw.trim()
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)```$/)
  if (fence) text = fence[1]!.trim()
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start >= 0 && end > start) text = text.slice(start, end + 1)
  try {
    const obj = JSON.parse(text) as { reply?: unknown; state?: Partial<CardState> }
    if (typeof obj.reply !== 'string') return { reply: fallbackReply, state: null, error: '缺少 reply' }
    return { reply: obj.reply, state: obj.state ?? null, error: null }
  } catch (err) {
    return { reply: fallbackReply, state: null, error: `JSON 解析失败: ${(err as Error).message}` }
  }
}

export class TraditionalCharacterCard {
  #provider: LLMProvider
  #profile: CharacterProfile
  #temperature: number
  #maxTokens: number
  #history: LLMMessage[] = []
  #state: CardState

  constructor(opts: {
    provider: LLMProvider
    profile: CharacterProfile
    temperature?: number
    maxTokens?: number
  }) {
    this.#provider = opts.provider
    this.#profile = opts.profile
    this.#temperature = opts.temperature ?? 0.7
    this.#maxTokens = opts.maxTokens ?? 800
    this.#state = {
      traits: [...opts.profile.traits],
      interests: [...opts.profile.interests],
      intimacy: 0,
    }
  }

  get state(): CardState {
    return { traits: [...this.#state.traits], interests: [...this.#state.interests], intimacy: this.#state.intimacy }
  }

  /** 传统角色卡的「新会话」：清空聊天记录（不保留任何状态以外的上下文）。 */
  resetHistory(): void {
    this.#history = []
  }

  async send(userText: string): Promise<CardTurnResult> {
    const before = this.state
    const system = cardSystemPrompt(this.#profile, this.#state)
    const messages: LLMMessage[] = [...this.#history, { role: 'user', content: userText }]

    const response = await this.#provider.complete({
      system,
      messages,
      temperature: this.#temperature,
      maxTokens: this.#maxTokens,
      jsonMode: true,
      meta: { userText, contract: 'card', cardState: this.state },
    })

    const parsed = parseCardOutput(response.text, response.text.trim())
    const appliedChanges: string[] = []

    if (parsed.state) {
      if (Array.isArray(parsed.state.traits)) {
        const next = parsed.state.traits.filter((t) => typeof t === 'string')
        if (JSON.stringify(next) !== JSON.stringify(this.#state.traits)) {
          appliedChanges.push(`traits: ${JSON.stringify(this.#state.traits)} -> ${JSON.stringify(next)}`)
          this.#state.traits = next
        }
      }
      if (Array.isArray(parsed.state.interests)) {
        const next = parsed.state.interests.filter((t) => typeof t === 'string')
        if (JSON.stringify(next) !== JSON.stringify(this.#state.interests)) {
          appliedChanges.push(`interests: ${JSON.stringify(this.#state.interests)} -> ${JSON.stringify(next)}`)
          this.#state.interests = next
        }
      }
      if (typeof parsed.state.intimacy === 'number' && Number.isFinite(parsed.state.intimacy)) {
        const next = Math.min(100, Math.max(0, parsed.state.intimacy))
        if (next !== this.#state.intimacy) {
          appliedChanges.push(`intimacy: ${this.#state.intimacy} -> ${next}`)
          this.#state.intimacy = next
        }
      }
    }

    this.#history.push({ role: 'user', content: userText })
    this.#history.push({ role: 'assistant', content: parsed.reply })

    const contextChars =
      system.length + messages.reduce((n, m) => n + m.content.length, 0)

    return {
      reply: parsed.reply,
      stateBefore: before,
      stateAfter: this.state,
      appliedChanges,
      contextChars,
      usage: response.usage,
      latencyMs: response.latencyMs,
      parseError: parsed.error,
    }
  }
}
