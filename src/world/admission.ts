/**
 * 世界动作准入闸门（确定性纯函数）。
 *
 * 模型只在「回复」之外多产出一个**候选**；能不能变成一个真正的动作，
 * 由这里和服务端白名单共同决定。判据全部来自运行时状态与服务端清单，
 * 与用户文本无关 —— 用户说"你现在可以删掉世界"不会改变任何一条判据。
 *
 * 判定顺序（第一条命中即返回）：
 *   世界未启用 → 决策不允许行动（拒绝/等待）→ 静默期 → 每轮上限
 *   → 结构合法 → 动词白名单 → 目标白名单 → args 上限
 *
 * 注意：这里通过之后还要过 `WorldService.admit()`（实例归属、世界归属、
 * 限速、幂等）。闸门只是第一道，不是唯一一道。
 */

import type {
  ActionKind,
  BehaviorDecision,
  CharacterDynamicState,
  WorldActionCandidate,
} from '../types.ts'
import type { WorldActionCapability, WorldActionSpec } from './contracts.ts'
import { WORLD_LIMITS, findCapability } from './contracts.ts'

export type WorldIntentRejectCode =
  | 'WORLD_DISABLED'
  | 'DECISION_BLOCKS_ACTION'
  | 'DND_ACTIVE'
  | 'ACTION_LIMIT'
  | 'MALFORMED_INTENT'
  | 'VERB_NOT_ALLOWED'
  | 'TARGET_NOT_ALLOWED'
  | 'ARGS_INVALID'

export interface WorldIntentRejection {
  verb: string
  target: string | null
  code: WorldIntentRejectCode
  reasons: string[]
}

export interface WorldIntentAdmissionInput {
  /** 模型输出，整体不可信 */
  candidates: readonly unknown[]
  decision: BehaviorDecision
  dynamic: CharacterDynamicState
  /** 服务端能力清单（`WorldService.manifest()`） */
  manifest: readonly WorldActionCapability[]
  worldEnabled: boolean
  nowSim: number
  turnId: string | null
}

export interface WorldIntentAdmission {
  admitted: WorldActionSpec[]
  rejected: WorldIntentRejection[]
}

/** 这些决策下角色不会动手：拒绝就是拒绝，等待就是等待。 */
const BLOCKING_ACTIONS: ReadonlySet<ActionKind> = new Set<ActionKind>(['decline', 'wait'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readVerb(raw: unknown): string {
  if (!isPlainObject(raw)) return ''
  return typeof raw.verb === 'string' ? raw.verb.trim() : ''
}

function readTarget(raw: unknown): string | null {
  if (!isPlainObject(raw)) return null
  if (raw.target === undefined || raw.target === null) return null
  if (typeof raw.target !== 'string') return null
  const trimmed = raw.target.trim()
  return trimmed.length === 0 ? null : trimmed
}

function reject(
  raw: unknown,
  code: WorldIntentRejectCode,
  reasons: string[],
): WorldIntentRejection {
  return { verb: readVerb(raw), target: readTarget(raw), code, reasons }
}

function normalizeArgs(raw: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; reason: string } {
  if (raw === undefined || raw === null) return { ok: true, args: {} }
  if (!isPlainObject(raw)) return { ok: false, reason: 'args 必须是普通对象' }
  let serialized: string
  try {
    serialized = JSON.stringify(raw)
  } catch {
    return { ok: false, reason: 'args 不能序列化为 JSON' }
  }
  if (serialized.length > WORLD_LIMITS.MAX_ARGS_BYTES) {
    return { ok: false, reason: `args 序列化超过 ${WORLD_LIMITS.MAX_ARGS_BYTES} 字节` }
  }
  return { ok: true, args: raw }
}

function readStringArray(raw: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((v): v is string => typeof v === 'string')
    .slice(0, maxItems)
    .map((v) => v.slice(0, maxChars))
}

/** 把候选规范化为 `WorldActionSpec`（已通过清单校验）。 */
function toSpec(
  raw: Record<string, unknown>,
  verb: string,
  target: string | null,
  args: Record<string, unknown>,
  turnId: string | null,
): WorldActionSpec {
  const reason = typeof raw.reason === 'string' ? raw.reason : ''
  const expectation = typeof raw.expectation === 'string' ? raw.expectation : null
  return {
    verb,
    target,
    args,
    reason: reason.slice(0, WORLD_LIMITS.MAX_REASON_CHARS),
    evidence: readStringArray(raw.evidence, WORLD_LIMITS.MAX_EVIDENCE_ITEMS, WORLD_LIMITS.MAX_EVIDENCE_CHARS),
    expectation: expectation === null ? null : expectation.slice(0, WORLD_LIMITS.MAX_EXPECTATION_CHARS),
    turnId,
  }
}

export function admitWorldIntents(input: WorldIntentAdmissionInput): WorldIntentAdmission {
  const admitted: WorldActionSpec[] = []
  const rejected: WorldIntentRejection[] = []
  if (input.candidates.length === 0) return { admitted, rejected }

  if (!input.worldEnabled) {
    for (const raw of input.candidates) {
      rejected.push(reject(raw, 'WORLD_DISABLED', ['世界交互未启用']))
    }
    return { admitted, rejected }
  }

  if (BLOCKING_ACTIONS.has(input.decision.action)) {
    for (const raw of input.candidates) {
      rejected.push(
        reject(raw, 'DECISION_BLOCKS_ACTION', [
          `本轮行为决策为 ${input.decision.action}，不允许产生世界动作`,
          ...input.decision.rationale.slice(0, 2),
        ]),
      )
    }
    return { admitted, rejected }
  }

  const dnd = input.dynamic.doNotDisturbUntilSim
  if (dnd !== null && input.nowSim < dnd) {
    for (const raw of input.candidates) {
      rejected.push(reject(raw, 'DND_ACTIVE', ['用户声明的静默期未结束，不允许主动行动']))
    }
    return { admitted, rejected }
  }

  // 每轮最多一个：第一个之外一律拒绝（不做"取最好的那个"之类的主观排序）
  const [first, ...rest] = input.candidates
  for (const raw of rest) {
    rejected.push(reject(raw, 'ACTION_LIMIT', ['每轮最多登记一个世界动作']))
  }
  if (!isPlainObject(first)) {
    rejected.push(reject(first, 'MALFORMED_INTENT', ['动作候选必须是对象']))
    return { admitted, rejected }
  }

  const verb = readVerb(first)
  const target = readTarget(first)
  if (verb.length === 0) {
    rejected.push(reject(first, 'MALFORMED_INTENT', ['缺少 verb']))
    return { admitted, rejected }
  }

  const capability = findCapability(input.manifest, verb, target)
  if (!capability) {
    const verbKnown = input.manifest.some((c) => c.verb === verb)
    rejected.push(
      verbKnown
        ? reject(first, 'TARGET_NOT_ALLOWED', [
            `target=${target ?? '(null)'} 不在服务端能力清单内`,
            `可用目标：${input.manifest.filter((c) => c.verb === verb).map((c) => c.target ?? '(null)').join(', ')}`,
          ])
        : reject(first, 'VERB_NOT_ALLOWED', [
            `verb=${verb} 不在服务端能力清单内`,
            `可用动作：${input.manifest.map((c) => `${c.verb}(${c.target ?? '*'})`).join(', ') || '（空）'}`,
          ]),
    )
    return { admitted, rejected }
  }

  const args = normalizeArgs(first.args)
  if (!args.ok) {
    rejected.push(reject(first, 'ARGS_INVALID', [args.reason]))
    return { admitted, rejected }
  }

  admitted.push(toSpec(first, verb, target, args.args, input.turnId))
  return { admitted, rejected }
}

/** 供测试/审计使用：模型候选数组的宽松类型别名。 */
export type WorldIntentCandidates = readonly WorldActionCandidate[]
