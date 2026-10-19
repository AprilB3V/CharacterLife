/**
 * Character Template —— 只读、版本化、可校验的角色设定。
 *
 * Template 与 Instance 的区别（这是本版本最重要的概念边界）：
 * - Template 是「沈知微这个人是谁」：人格、背景、兴趣、语音包、剧情事件骨架。
 *   它**不随对话改变**，只能通过显式的新版本发布来变更。
 * - Instance 是「某个玩家在这一局里遇到的沈知微」：关系、记忆、时间线进度。
 *
 * 版本化方式：`(id, version)` 唯一，附带内容哈希。实例会记住自己绑定的
 * `(templateId, version, hash)`，恢复时三者必须对齐 —— 否则说明模板被悄悄改过。
 */

import { createHash } from 'node:crypto'
import type { CharacterProfile, CharacterVoice, EventKind } from '../types.ts'

export interface TemplateEventSpec {
  id: string
  atSim: number
  kind: EventKind
  title: string
  description: string
  payload: Record<string, unknown>
}

export interface CharacterTemplate {
  id: string
  version: number
  profile: CharacterProfile
  voice: CharacterVoice
  timeline: TemplateEventSpec[]
  createdAtWall: string
  /** 由内容计算的哈希；任何字段变化都会改变它 */
  contentHash: string
  /** 标记字段：运行时深冻结，模板不可被对话路径修改 */
  readonly: true
}

export interface TemplateInput {
  id?: string
  version: number
  profile: CharacterProfile
  voice: CharacterVoice
  timeline?: TemplateEventSpec[]
  createdAtWall?: string
}

export class TemplateIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TemplateIntegrityError'
  }
}

/** 稳定序列化：键排序，保证同一内容得到同一哈希。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

export function hashTemplateContent(input: {
  id: string
  version: number
  profile: CharacterProfile
  voice: CharacterVoice
  timeline: TemplateEventSpec[]
}): string {
  return createHash('sha256')
    .update(
      stableStringify({
        id: input.id,
        version: input.version,
        profile: input.profile,
        voice: input.voice,
        timeline: input.timeline,
      }),
    )
    .digest('hex')
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
    Object.freeze(value)
  }
  return value
}

/**
 * 定义一个模板。返回深冻结对象：任何「改一下人格」的尝试都会失败，
 * 想要新人格只能定义**新版本**（version+1）。
 */
export function defineTemplate(input: TemplateInput): CharacterTemplate {
  const id = input.id ?? input.profile.id
  if (!Number.isInteger(input.version) || input.version < 1) {
    throw new RangeError('模板 version 必须是 ≥1 的整数')
  }
  const timeline = input.timeline ?? []
  const base = {
    id,
    version: input.version,
    profile: input.profile,
    voice: input.voice,
    timeline,
  }
  const contentHash = hashTemplateContent(base)
  return deepFreeze({
    ...base,
    createdAtWall: input.createdAtWall ?? new Date().toISOString(),
    contentHash,
    readonly: true as const,
  })
}

/** 重新计算哈希并与存储值比对（用于恢复阶段的完整性校验）。 */
export function verifyTemplate(template: CharacterTemplate): void {
  const expected = hashTemplateContent({
    id: template.id,
    version: template.version,
    profile: template.profile,
    voice: template.voice,
    timeline: template.timeline,
  })
  if (expected !== template.contentHash) {
    throw new TemplateIntegrityError(
      `模板内容哈希不匹配：存储=${template.contentHash.slice(0, 12)}… 实际=${expected.slice(0, 12)}…`,
    )
  }
}

export interface TemplateVersionCheck {
  ok: boolean
  code: 'OK' | 'VERSION_MISMATCH' | 'HASH_MISMATCH' | 'TEMPLATE_MISSING'
  detail: string
}

/**
 * 校验实例绑定的模板版本。
 * 默认 `strict`：必须完全一致；`allowNewer` 只允许模板降级时由显式迁移触发，
 * 不会在恢复流程中自动接受。
 */
export function checkTemplateVersion(
  template: CharacterTemplate | null,
  expected: { templateId: string; templateVersion: number; templateHash: string },
  mode: 'strict' | 'allowHashMatch' = 'strict',
): TemplateVersionCheck {
  if (!template) {
    return { ok: false, code: 'TEMPLATE_MISSING', detail: `找不到模板 ${expected.templateId}@${expected.templateVersion}` }
  }
  if (template.id !== expected.templateId) {
    return { ok: false, code: 'VERSION_MISMATCH', detail: `实例绑定 ${expected.templateId}，加载到 ${template.id}` }
  }
  if (mode === 'strict' && template.version !== expected.templateVersion) {
    return {
      ok: false,
      code: 'VERSION_MISMATCH',
      detail: `实例绑定版本 ${expected.templateVersion}，模板为 ${template.version}`,
    }
  }
  if (template.contentHash !== expected.templateHash) {
    return {
      ok: false,
      code: 'HASH_MISMATCH',
      detail: '模板内容哈希与实例记录不一致（模板被修改过？）',
    }
  }
  return { ok: true, code: 'OK', detail: `模板 ${template.id}@${template.version} 校验通过` }
}
