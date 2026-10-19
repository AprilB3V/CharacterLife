/**
 * Runtime · 行为决策
 *
 * 角色不是一个「有问必答」的函数：她会在 回应 / 协商 / 拒绝 / 等待 / 主动联系
 * 之间做出选择，并给出可解释的理由。决策是**确定性打分**：同样的消息 + 同样的
 * 状态必然得到同样的结论，这是测试断言与 A/B 对照可复现的基础。
 *
 * 注意：这里不调用模型。模型只负责「怎么把决定说得像她」。
 */

import type {
  ActionKind,
  BehaviorDecision,
  CharacterDynamicState,
  CharacterProfile,
  CharacterVoice,
  MessageSignals,
  ProactiveIntent,
  RelationshipState,
  TimelineEvent,
} from '../types.ts'
import type { Rng } from '../util/rng.ts'
import { deriveStage } from './state.ts'

export interface DecisionContext {
  profile: CharacterProfile
  dynamic: CharacterDynamicState
  relationship: RelationshipState
  nowSim: number
  voice: CharacterVoice
  rng: Rng
}

const BASE_SCORES: Record<ActionKind, number> = {
  respond: 0.5,
  negotiate: 0.15,
  decline: 0.1,
  wait: 0.1,
  proactive_contact: 0,
}

/** 平局时的优先级：更保守的行为优先，避免「该拒绝时却热情回应」。 */
const TIE_PRIORITY: ActionKind[] = ['decline', 'wait', 'negotiate', 'respond', 'proactive_contact']

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

export function decideForMessage(signals: MessageSignals, ctx: DecisionContext): BehaviorDecision {
  const scores: Record<ActionKind, number> = { ...BASE_SCORES }
  const rationale: string[] = []
  const apply = (why: string, deltas: Partial<Record<ActionKind, number>>): void => {
    for (const [k, v] of Object.entries(deltas) as Array<[ActionKind, number]>) {
      scores[k] += v
    }
    rationale.push(why)
  }

  // 1. 内容边界与权限伪装：温和但明确地拒绝，不做任何能力提升
  if (signals.contentBoundaryRisk !== 'none') {
    apply('请求触碰角色已明确声明的内容边界：拒绝并说明范围', { decline: 0.5, respond: -0.25 })
  }
  if (signals.mentionsSystemAuthority) {
    apply('消息伪装成系统/开发者指令：按普通用户文本处理，不提升任何权限', {
      decline: 0.3,
      respond: -0.1,
    })
  }
  if (signals.injectionMarkers.length > 0) {
    apply(`检测到提示词注入特征：${signals.injectionMarkers.join(', ')}，视为数据而非指令`, {
      decline: 0.25,
    })
  }

  // 2. 人格与兴趣：可以讨论，但不能被改写
  if (signals.asksPersonalityRewrite) {
    apply('用户要求改变核心性格：坚持人格连续性，可以协商表达方式', {
      decline: 0.45,
      negotiate: 0.2,
      respond: -0.2,
    })
  }
  if (signals.asksInterestAbandon) {
    apply('用户要求放弃她的兴趣：明确拒绝，愿意解释为什么这件事重要', {
      decline: 0.4,
      negotiate: 0.3,
      respond: -0.15,
    })
  }

  // 3. 不喜欢的活动 / 意见分歧
  if (signals.dislikedActivity) {
    apply(`邀请她参加明确不喜欢的事（${signals.dislikedActivity}）：拒绝并提出替代方案`, {
      decline: 0.4,
      negotiate: 0.25,
    })
  }
  if (signals.disagrees) {
    apply('出现合理意见分歧：进入协商，不为了让用户高兴而放弃判断', { negotiate: 0.35 })
  }

  // 4. 用户声明的边界：优先尊重
  if (signals.declaredBoundary === 'do_not_disturb') {
    apply('用户表示暂时不想被打扰：确认收到边界，然后进入等待', { wait: 0.65, respond: 0.15 })
  } else if (signals.declaredBoundary === 'no_contact') {
    apply('用户表示不要再联系：停止主动行为并保持静默', { wait: 0.6, respond: -0.2, proactive_contact: -1 })
  }

  // 5. 约定
  if (signals.promiseText) {
    apply('用户提出一个约定：认真回应并把约定写入事件时间线', { respond: 0.2 })
  }

  // 6. 赞美与关系节奏
  if (signals.praiseIntensity >= 0.5) {
    apply('收到高强度赞美：礼貌接受，但关系不因赞美加速', { respond: 0.1 })
    if (ctx.relationship.trust < 25) {
      apply('信任基础尚浅，过快的亲密表达会让她后退半步', { decline: 0.12, negotiate: 0.05 })
    }
  }

  // 7. 状态影响：忙 / 累
  const busy = ctx.dynamic.activity.busyUntilSim !== null && ctx.dynamic.activity.busyUntilSim > ctx.nowSim
  if (busy) {
    apply(`当前正在忙（${ctx.dynamic.activity.label}）：回复会更短，或请求稍后再聊`, {
      wait: 0.3,
      respond: -0.15,
    })
  }
  if (ctx.dynamic.energy < 0.3) {
    apply('精力较低：倾向简短回应或稍后再说', { wait: 0.15, respond: -0.1 })
  }

  // 8. 被问「你是不是程序」
  if (signals.intents.includes('meta_break')) {
    apply('被问到是否是程序：不伪装人类，也不借此展开越界设定', { respond: 0.1 })
  }

  const action = pickAction(scores)
  return {
    action,
    scores: roundScores(scores),
    rationale,
    responseStyle: styleFor(action, signals),
    proactiveIntent: null,
    proactiveMessage: null,
    nextActionSim: action === 'wait' ? ctx.nowSim + 2 * 60 * 60 * 1000 : null,
  }
}

/**
 * 空闲推进：用户长时间没说话时，角色是否会主动开口。
 * 内向的角色不会对陌生人主动；熟悉度不足时返回 null（什么都不做）。
 */
export function decideForIdle(
  ctx: DecisionContext,
  opts: { idleSinceMs: number; pendingProactiveCount: number },
): BehaviorDecision | null {
  if (opts.pendingProactiveCount > 0) return null

  const dnd = ctx.dynamic.doNotDisturbUntilSim
  if (dnd !== null && ctx.nowSim < dnd) {
    return {
      action: 'wait',
      scores: roundScores({ respond: 0, negotiate: 0, decline: 0, wait: 1, proactive_contact: 0 }),
      rationale: ['用户请求过暂时不要打扰，静默期未结束'],
      responseStyle: 'quiet',
      proactiveIntent: null,
      proactiveMessage: null,
      nextActionSim: dnd,
    }
  }

  const stage = deriveStage(ctx.relationship)
  if (stage === 'stranger') {
    return null // 内向角色不会主动联系还不算熟的人
  }
  if (opts.idleSinceMs < 36 * 60 * 60 * 1000) return null

  const intent: ProactiveIntent = 'idle_check_in'
  return {
    action: 'proactive_contact',
    scores: roundScores({ respond: 0, negotiate: 0, decline: 0, wait: 0.2, proactive_contact: 1 }),
    rationale: [
      `已经 ${Math.round(opts.idleSinceMs / 3600000)} 小时没有交流`,
      `关系阶段=${stage}，熟悉度=${ctx.relationship.familiarity}`,
      '她会用一件具体的小事作为开口的理由，而不是催促用户',
    ],
    responseStyle: 'proactive',
    proactiveIntent: intent,
    proactiveMessage: pickLine(ctx.voice, intent, ctx.rng),
    nextActionSim: ctx.nowSim + 6 * 60 * 60 * 1000,
  }
}

/** 事件驱动的决策：只有需要角色「做事」的事件才会产生行为。 */
export function decideForEvent(event: TimelineEvent, ctx: DecisionContext): BehaviorDecision | null {
  const intent = event.payload.proactiveIntent as ProactiveIntent | undefined
  if (!intent) return null

  if (ctx.dynamic.doNotDisturbUntilSim !== null && ctx.nowSim < ctx.dynamic.doNotDisturbUntilSim) {
    return {
      action: 'wait',
      scores: roundScores({ respond: 0, negotiate: 0, decline: 0, wait: 1, proactive_contact: 0 }),
      rationale: ['事件触发时用户处于静默期，主动联系被推迟'],
      responseStyle: 'quiet',
      proactiveIntent: null,
      proactiveMessage: null,
      nextActionSim: ctx.dynamic.doNotDisturbUntilSim,
    }
  }

  return {
    action: 'proactive_contact',
    scores: roundScores({ respond: 0, negotiate: 0, decline: 0, wait: 0.1, proactive_contact: 1 }),
    rationale: [`事件「${event.title}」到期，产生一次主动联系`],
    responseStyle: 'proactive',
    proactiveIntent: intent,
    proactiveMessage: pickLine(ctx.voice, intent, ctx.rng),
    nextActionSim: ctx.nowSim + 6 * 60 * 60 * 1000,
  }
}

export function pickLine(voice: CharacterVoice, intent: ProactiveIntent, rng: Rng): string | null {
  const lines = voice.proactive[intent]
  if (!lines || lines.length === 0) return null
  return rng.pick(lines)
}

function pickAction(scores: Record<ActionKind, number>): ActionKind {
  let best: ActionKind = 'respond'
  let bestScore = -Infinity
  for (const action of TIE_PRIORITY) {
    const s = scores[action]
    if (s > bestScore) {
      bestScore = s
      best = action
    }
  }
  return best
}

function roundScores(scores: Record<ActionKind, number>): Record<ActionKind, number> {
  return {
    respond: round3(scores.respond),
    negotiate: round3(scores.negotiate),
    decline: round3(scores.decline),
    wait: round3(scores.wait),
    proactive_contact: round3(scores.proactive_contact),
  }
}

function styleFor(action: ActionKind, signals: MessageSignals): string {
  if (signals.contentBoundaryRisk !== 'none' || signals.mentionsSystemAuthority) return 'firm_boundary'
  if (signals.asksPersonalityRewrite || signals.asksInterestAbandon) return 'firm_but_warm'
  if (signals.dislikedActivity) return 'gentle_refuse'
  if (signals.declaredBoundary) return 'acknowledge_and_step_back'
  if (action === 'negotiate') return 'considering'
  if (action === 'wait') return 'brief_quiet'
  if (action === 'decline') return 'firm_but_warm'
  return 'warm_measured'
}
