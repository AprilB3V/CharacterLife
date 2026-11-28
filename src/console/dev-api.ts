/**
 * Developer mode: owner edits to an instance's semantics from the console.
 *
 * Every write goes through the kernel's own channels as OWNER_ACTOR, so Policy, audit and the
 * integrity ledger see it exactly like any other owner operation:
 *   Self.condition / Relationship / Motivation goals & drives → submitProposals (persisted events)
 *   Memory → writeMemory / deleteMemory; an edit supersedes (soft-delete + new entry citing the old id)
 *   Situation / Observation → a runtime percept (in-process only, as for every other percept)
 *   Commitments → settle kept / broken
 * Self.persona stays read-only: it is part of the template and covered by its content hash.
 * Affordances are registered by extensions in code, so there is nothing to edit here.
 */

import type { InstanceRuntime } from '../runtime/instance-runtime.ts'
import { OWNER_ACTOR } from '../kernel/policy/policy.ts'
import type { CharacterGoal, EpistemicStatus, MemoryKind, MemoryOrigin, RelationshipStage, StateProposal } from '../kernel/types.ts'
import type { PerceptFact } from '../kernel/semantics/observation.ts'

export class DevEditError extends Error {}

type Body = Record<string, unknown>
type Result = { ok: true; message: string; id?: string }

const SOURCE = 'console-dev'
const STAGES: RelationshipStage[] = ['stranger', 'acquaintance', 'familiar', 'friend', 'close']
const STATUSES: EpistemicStatus[] = ['fact', 'speculation', 'fiction']
const ORIGINS: MemoryOrigin[] = ['user_message', 'character_message', 'runtime_event', 'user_confirmed', 'character_inference', 'import']
const KEY = /^[A-Za-z0-9_.:-]{1,64}$/

function text(body: Body, key: string, opts: { required?: boolean; max?: number } = {}): string | undefined {
    const value = body[key]
    if (value === undefined || value === null || value === '') {
        if (opts.required) throw new DevEditError(`缺少 ${key}`)
        return undefined
    }
    if (typeof value !== 'string') throw new DevEditError(`${key} 必须是文本`)
    const trimmed = value.trim()
    if (opts.required && !trimmed) throw new DevEditError(`缺少 ${key}`)
    if (trimmed.length > (opts.max ?? 2000)) throw new DevEditError(`${key} 过长`)
    return trimmed
}

function num(body: Body, key: string, min: number, max: number, required = false): number | undefined {
    const value = body[key]
    if (value === undefined || value === null || value === '') {
        if (required) throw new DevEditError(`缺少 ${key}`)
        return undefined
    }
    const n = typeof value === 'number' ? value : Number(value)
    if (!Number.isFinite(n) || n < min || n > max) throw new DevEditError(`${key} 需在 ${min}–${max} 之间`)
    return n
}

function oneOf<T extends string>(body: Body, key: string, allowed: readonly T[], fallback?: T): T {
    const value = body[key] ?? fallback
    if (!allowed.includes(value as T)) throw new DevEditError(`${key} 只能是 ${allowed.join(' / ')}`)
    return value as T
}

function scalar(value: unknown): string | number | boolean {
    if (typeof value === 'number' || typeof value === 'boolean') return value
    if (typeof value !== 'string') throw new DevEditError('值必须是文本、数字或布尔')
    const trimmed = value.trim()
    if (trimmed === 'true' || trimmed === 'false') return trimmed === 'true'
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
    if (trimmed.length > 500) throw new DevEditError('值过长')
    return trimmed
}

export function applyDevEdit(rt: InstanceRuntime, op: string, body: Body): Result {
    const ws = rt.workspace
    let seq = 0
    const proposal = (target: StateProposal['target'], path: string, value: unknown): StateProposal =>
        ({ id: `dev_${Date.now().toString(36)}_${seq++}`, target, op: 'set', path, value, reason: '主人后台 · 开发者模式', evidence: [] })
    const submit = (proposals: StateProposal[], message: string): Result => {
        if (!proposals.length) throw new DevEditError('没有要修改的字段')
        const outcome = ws.submitProposals(proposals, OWNER_ACTOR, { source: SOURCE })
        if (outcome.rejected.length) {
            throw new DevEditError(`被 Policy 拒绝：${outcome.rejected.map(item => `${item.proposal.path}（${item.decision.reasons.join('；') || item.decision.code}）`).join('，')}`)
        }
        return { ok: true, message }
    }
    // Situation and Observation change only through a percept, the same way the world changes them.
    const percept = (textValue: string, facts: PerceptFact[], events: string[] = []) => {
        const appended = ws.observation.append({ atSim: ws.nowSim(), source: 'runtime', from: 'console', text: textValue, facts, events, ref: null })
        ws.situation.apply(appended)
        return appended
    }
    // Restate the whole belief minus one entry: the only way to drop a fact without a world snapshot.
    const restateWithout = (drop: { fact?: string; item?: string }): PerceptFact[] => {
        const s = ws.situation.current()
        return [
            { key: 'reset', value: true },
            ...(s.location !== null ? [{ key: 'location', value: s.location }] : []),
            { key: 'snapshot', value: true },
            ...s.present.map(value => ({ key: 'present', value })),
            ...s.affords.map(value => ({ key: 'affords', value })),
            ...Object.entries(s.inventory).filter(([item]) => item !== drop.item).map(([item, value]) => ({ key: `inventory.${item}`, value })),
            ...Object.entries(s.facts).filter(([key]) => key !== drop.fact).map(([key, value]) => ({ key, value })),
        ]
    }

    switch (op) {
        case 'condition': {
            const proposals: StateProposal[] = []
            const mood = text(body, 'mood', { max: 40 })
            const valence = num(body, 'valence', -1, 1)
            const arousal = num(body, 'arousal', 0, 1)
            const energy = num(body, 'energy', 0, 1)
            const activity = text(body, 'activity', { max: 60 })
            if (mood !== undefined) proposals.push(proposal('dynamic', 'mood.label', mood))
            if (valence !== undefined) proposals.push(proposal('dynamic', 'mood.valence', valence))
            if (arousal !== undefined) proposals.push(proposal('dynamic', 'mood.arousal', arousal))
            if (energy !== undefined) proposals.push(proposal('dynamic', 'energy', energy))
            if (activity !== undefined) proposals.push(proposal('dynamic', 'activity.label', activity))
            return submit(proposals, '身心状况已更新')
        }
        case 'relationship': {
            const proposals: StateProposal[] = []
            const familiarity = num(body, 'familiarity', 0, 100)
            const trust = num(body, 'trust', 0, 100)
            if (familiarity !== undefined) proposals.push(proposal('relationship', 'familiarity', familiarity))
            if (trust !== undefined) proposals.push(proposal('relationship', 'trust', trust))
            if (body.stage !== undefined && body.stage !== null && body.stage !== '') proposals.push(proposal('relationship', 'stage', oneOf(body, 'stage', STAGES)))
            return submit(proposals, '关系认识已更新')
        }
        case 'goal-upsert': {
            const title = text(body, 'title', { required: true, max: 120 })!
            const progress = num(body, 'progress', 0, 1) ?? 0
            const kind = oneOf(body, 'kind', ['personal', 'relational'] as const, 'personal')
            const goals: CharacterGoal[] = ws.motivation.goals().map(goal => ({ ...goal }))
            const id = text(body, 'id', { max: 64 })
            const existing = id ? goals.find(goal => goal.id === id) : undefined
            if (existing) Object.assign(existing, { title, progress, kind })
            else goals.push({ id: id && KEY.test(id) ? id : `goal_${Date.now().toString(36)}`, title, progress, kind })
            return submit([proposal('dynamic', 'goals', goals)], existing ? `目标「${title}」已修改` : `目标「${title}」已添加`)
        }
        case 'goal-delete': {
            const id = text(body, 'id', { required: true, max: 64 })!
            const goals = ws.motivation.goals()
            if (!goals.some(goal => goal.id === id)) throw new DevEditError('目标不存在')
            return submit([proposal('dynamic', 'goals', goals.filter(goal => goal.id !== id))], '目标已删除')
        }
        case 'drive': {
            const id = text(body, 'id', { required: true, max: 32 })!
            if (!ws.motivation.drives().some(drive => drive.name === id)) throw new DevEditError('该驱力未在模板中配置')
            return submit([proposal('dynamic', `drives.${id}`, num(body, 'value', 0, 1, true))], `驱力 ${id} 已设定`)
        }
        case 'memory-add':
        case 'memory-edit': {
            const input = {
                kind: oneOf(body, 'kind', ['episodic', 'user'] as MemoryKind[], 'episodic'),
                title: text(body, 'title', { required: true, max: 120 })!,
                content: text(body, 'content', { required: true, max: 2000 })!,
                status: oneOf(body, 'status', STATUSES, 'fact'),
                origin: oneOf(body, 'origin', ORIGINS, 'import'),
                salience: num(body, 'salience', 0, 1) ?? 0.5,
                tags: (text(body, 'tags', { max: 300 }) ?? '').split(/[,，\s]+/).filter(Boolean).slice(0, 12),
                confirmed: body.kind === 'user',
            }
            let sourceRef: string | null = 'console:dev'
            if (op === 'memory-edit') {
                const id = text(body, 'id', { required: true, max: 64 })!
                if (!ws.memory.get(id) || ws.memory.get(id)!.deletedAtSim !== null) throw new DevEditError('记忆不存在或已删除')
                if (!ws.deleteMemory(id, OWNER_ACTOR)) throw new DevEditError('旧记忆删除失败')
                sourceRef = `console:supersedes:${id}`
            }
            const written = ws.writeMemory(input, OWNER_ACTOR, sourceRef)
            if (!written.written) throw new DevEditError(`记忆写入被拒绝（${written.verdict}）`)
            return { ok: true, id: written.entryId!, message: op === 'memory-edit' ? '记忆已修改（旧版本软删除，审计保留）' : '记忆已添加' }
        }
        case 'fact-set': {
            const key = text(body, 'key', { required: true, max: 64 })!
            if (!KEY.test(key) || ['reset', 'snapshot', 'present', 'affords', 'event'].includes(key)) throw new DevEditError('键名无效或为保留字')
            const value = scalar(body.value)
            percept(`后台设定事实 ${key}=${String(value)}`, [{ key, value }])
            return { ok: true, message: `事实 ${key} 已设定（仅本进程）` }
        }
        case 'fact-delete': {
            const key = text(body, 'key', { required: true, max: 64 })!
            if (!(key in ws.situation.current().facts)) throw new DevEditError('事实不存在')
            percept(`后台删除事实 ${key}`, restateWithout({ fact: key }))
            return { ok: true, message: `事实 ${key} 已删除（仅本进程）` }
        }
        case 'inventory-set': {
            const item = text(body, 'item', { required: true, max: 64 })!
            if (!KEY.test(item)) throw new DevEditError('物品名只能含字母、数字和 _.:-')
            const count = num(body, 'count', 0, 1_000_000, true)!
            percept(`后台设定库存 ${item}=${count}`, [{ key: `inventory.${item}`, value: count }])
            return { ok: true, message: `库存 ${item} 已设定（仅本进程）` }
        }
        case 'inventory-delete': {
            const item = text(body, 'item', { required: true, max: 64 })!
            if (!(item in ws.situation.current().inventory)) throw new DevEditError('物品不存在')
            percept(`后台移除库存 ${item}`, restateWithout({ item }))
            return { ok: true, message: `库存 ${item} 已移除（仅本进程）` }
        }
        case 'location': {
            const location = text(body, 'location', { required: true, max: 80 })!
            percept(`后台设定位置 ${location}`, [{ key: 'location', value: location }])
            return { ok: true, message: '位置已设定（仅本进程）' }
        }
        case 'observation-add': {
            const content = text(body, 'text', { required: true, max: 500 })!
            const events = (text(body, 'events', { max: 300 }) ?? '').split(/[,，\s]+/).filter(Boolean).slice(0, 8)
            const added = percept(content, [], events)
            return { ok: true, id: String(added.seq), message: '已注入一条观察（仅本进程）' }
        }
        case 'commitment-settle': {
            const id = text(body, 'id', { required: true, max: 64 })!
            const status = oneOf(body, 'status', ['kept', 'broken'] as const)
            const found = ws.motivation.get(id)
            if (!found) throw new DevEditError('承诺不存在')
            // Settle only: no milestone or memory side effects, unlike the runtime's own settlement.
            if (!ws.motivation.settle(id, status, 'console:dev')) throw new DevEditError('承诺已结算')
            ws.audit.append('proposal_applied', OWNER_ACTOR.id, `承诺 ${id} 被标记为${status === 'kept' ? '已兑现' : '未兑现'}`, { semantic: 'motivation', source: SOURCE })
            return { ok: true, message: status === 'kept' ? '承诺已标记兑现' : '承诺已标记未兑现' }
        }
        default:
            throw new DevEditError(`未知操作 ${op}`)
    }
}
