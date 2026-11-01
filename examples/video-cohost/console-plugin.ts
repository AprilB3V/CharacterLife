/**
 * Probably Stolen adapter backend, contributed to the owner console as a plugin.
 *
 * Panels are structured data only; actions run server-side under the instance lock.
 */
import type { ConsoleAction, ConsolePanel, ConsolePlugin, ConsoleValue } from '../../src/console/plugin.ts'
import type { JingjingGameAdapter } from './game-adapter.ts'
import { EVENT_SOURCES } from './season/events.ts'
import { REVIEW_ALWAYS, REVIEW_PASSTHROUGH } from './world-review.ts'

const MISSING_EVENTS = 'sale:<item>（含售价/利润）、rent_due、inspection_passed / inspection_failed、fine、raid、evidence_removal_used、'
    + 'investigation_reset、achievement:<id>、store_bought、game_over:<cause>、story:mentor.introduction、story:ai.first_encounter。'
    + '适配层能接收这些事件，但读取器与中转目前不产生；详见 docs/VIDEO_COHOST_SEASON1.md。'

const text = (value: unknown): string => typeof value === 'string' ? value : String(value ?? '')
const decide = (id: string, kind: string): ConsoleAction[] => [
    { id: `${kind}.approve`, label: '批准', tone: 'primary', params: { id } },
    { id: `${kind}.reject`, label: '拒绝', tone: 'danger', params: { id } },
]

export function jingjingConsolePlugin(adapter: JingjingGameAdapter): ConsolePlugin {
    const panels = (): ConsolePanel[] => {
        const season = adapter.season.state()
        const workspace = adapter.workspace
        const pendingWorld = adapter.worldReview.list('pending')
        const decidedWorld = adapter.worldReview.list().filter(item => item.status !== 'pending').slice(-20).reverse()
        const mode = adapter.worldReview.mode()
        const episode = season.episodes.at(-1) ?? null
        const review = [...season.episodes].reverse().find(item => item.review && !item.reviewApplied) ?? null
        const reviewDecisions = review?.memoryDecisions ?? {}
        const reviewFlags = review?.review?.flags ?? []
        const reviewPending = review ? review.review!.memories.filter(memory => !reviewDecisions[memory.id]).length
            + reviewFlags.filter(id => season.flagCandidates.find(flag => flag.id === id)?.status === 'pending').length : 0
        const script = adapter.season.script
        const beat = script.beats.find(item => item.id === season.current)

        return [
            {
                id: 'world-review', title: '世界事件审批', badge: pendingWorld.length,
                sections: [
                    { kind: 'fields', title: '模式', items: [
                        { label: '当前模式', value: mode === 'review' ? '审批：关键事件的效果等批准' : '自动：效果立即生效' },
                        { label: '直通（不审批）', value: `${REVIEW_PASSTHROUGH.join('、')}；例外：${REVIEW_ALWAYS.join('、')}` },
                        { label: '说明', value: '事件本身实时进入 Observation / Situation；待审的是推进剧本节拍与写入剧情记忆。' },
                    ] },
                    { kind: 'actions', title: '操作', actions: [
                        mode === 'review'
                            ? { id: 'world.mode', label: '切到自动', params: { mode: 'auto' }, confirm: '切到自动后，新的关键事件效果会立即生效。继续？' }
                            : { id: 'world.mode', label: '切到审批', params: { mode: 'review' } },
                        { id: 'world.approveAll', label: `按顺序批准全部（${pendingWorld.length}）`, tone: 'primary', confirm: '按到达顺序批准全部待审效果？' },
                    ] },
                    { kind: 'table', title: '待审', empty: '没有待审的世界事件效果',
                        columns: [{ key: 'id', label: 'ID' }, { key: 'events', label: '事件' }, { key: 'summary', label: '摘要' }, { key: 'ref', label: '出处' }, { key: 'source', label: '来源' }],
                        rows: pendingWorld.map(item => ({ cells: { id: item.id, events: item.events.join('、'), summary: item.summary, ref: item.ref, source: item.source === 'event' ? '读取器事件' : '快照派生' },
                            actions: decide(item.id, 'world') })) },
                    { kind: 'table', title: '最近已处理', empty: '暂无',
                        columns: [{ key: 'id', label: 'ID' }, { key: 'events', label: '事件' }, { key: 'status', label: '结果' }, { key: 'ref', label: '出处' }],
                        rows: decidedWorld.map(item => ({ cells: { id: item.id, events: item.events.join('、'), status: item.status === 'approved' ? '已批准' : '已拒绝', ref: item.ref } })) },
                ],
            },
            {
                id: 'season', title: '剧本', sections: [
                    { kind: 'fields', title: script.title, items: [
                        { label: '绑定的局', value: season.runId },
                        { label: '当前节拍', value: beat ? `${beat.id} ${beat.actTitle}·${beat.title}` : '尚未开局' },
                        { label: '当前立场', value: beat?.stance ?? null },
                        { label: '一次性插曲', value: season.transient },
                        { label: '季终', value: season.ended ? `${season.ended.kind === 'success' ? '终幕' : '失败'} ${season.ended.beatId}${season.ended.cause ? `（${season.ended.cause}）` : ''}` : '进行中' },
                        { label: '最近快照', value: season.tracked ? `第 ${season.tracked.day ?? '?'} 天，资金 ${season.tracked.cash}，调查 ${season.tracked.investigation ?? '?'}` : '无' },
                    ] },
                    { kind: 'table', title: '节拍', columns: [{ key: 'id', label: 'ID' }, { key: 'act', label: '幕' }, { key: 'title', label: '节拍' },
                        { key: 'trigger', label: '触发' }, { key: 'requires', label: '前置' }, { key: 'count', label: '进入次数' }, { key: 'firstRef', label: '首次出处' }],
                        rows: script.beats.map(item => ({ cells: { id: item.id, act: item.actTitle, title: item.title,
                            trigger: item.trigger.all ? `同时：${item.trigger.all.join(' + ')}` : (item.trigger.any ?? []).join(' / '),
                            requires: item.requires.join('、') || '—', count: season.entered[item.id]?.count ?? 0, firstRef: season.entered[item.id]?.firstRef ?? null } })) },
                    { kind: 'table', title: '推进记录（最近 30 条）', empty: '还没有推进', columns: [{ key: 'beat', label: '节拍' }, { key: 'events', label: '事件' }, { key: 'ref', label: '出处' }, { key: 'episode', label: '期' }],
                        rows: season.progress.slice(-30).reverse().map(item => ({ cells: { beat: item.beatId, events: item.events.join('、'), ref: item.ref, episode: item.episode } })) },
                ],
            },
            {
                id: 'episode', title: '每期与 Flag', badge: reviewPending,
                sections: [
                    { kind: 'fields', title: '本期', items: [
                        { label: '期数', value: episode ? `第 ${episode.n} 期${episode.closedAtSim === null ? '（进行中）' : '（已收尾）'}` : '尚未开播' },
                        { label: '待审核清单', value: review?.review?.reviewId ?? '无' },
                    ] },
                    { kind: 'actions', title: '操作', actions: [
                        { id: 'episode.close', label: '收尾本期', confirm: '收尾后会生成待审核清单，下一期要等审核完成才开场。继续？' },
                        ...(review ? [{ id: 'review.finish', label: '完成审核', confirm: '未决定的候选记忆将被丢弃，未决定的 flag 留到下次审核。继续？' }] : []),
                    ] },
                    { kind: 'table', title: '候选记忆', empty: '没有待审核的候选记忆', columns: [{ key: 'id', label: 'ID' }, { key: 'title', label: '标题' }, { key: 'content', label: '内容' }, { key: 'refs', label: '出处' }, { key: 'decision', label: '决定' }],
                        rows: (review?.review?.memories ?? []).map(memory => ({ cells: { id: memory.id, title: memory.title, content: memory.content, refs: memory.sourceRefs.join('、'),
                            decision: reviewDecisions[memory.id] === 'accept' ? '已接受' : reviewDecisions[memory.id] === 'reject' ? '已拒绝' : '待定' },
                            actions: reviewDecisions[memory.id] ? [] : [
                                { id: 'review.memory', label: '接受', tone: 'primary', params: { reviewId: review!.review!.reviewId, id: memory.id, decision: 'accept' } },
                                { id: 'review.memory', label: '拒绝', tone: 'danger', params: { reviewId: review!.review!.reviewId, id: memory.id, decision: 'reject' } },
                            ] })) },
                    { kind: 'table', title: 'Flag 候选', empty: '还没有 flag 候选', columns: [{ key: 'id', label: 'ID' }, { key: 'text', label: '原话' }, { key: 'kind', label: '判定规则' },
                        { key: 'dueDay', label: '截止天' }, { key: 'status', label: '状态' }, { key: 'ref', label: '出处' }],
                        rows: season.flagCandidates.slice(-30).reverse().map(flag => ({ cells: { id: flag.id, text: flag.text, kind: flag.kind, dueDay: flag.dueDay ?? null,
                            status: flag.status, ref: flag.sourceRef },
                            actions: review && reviewFlags.includes(flag.id) && flag.status === 'pending' ? [
                                ...(flag.kind === 'needs_clarification' ? [] : [{ id: 'review.flag', label: '收为承诺', tone: 'primary' as const,
                                    params: { reviewId: review.review!.reviewId, id: flag.id, decision: 'accept' },
                                    fields: [{ key: 'dueDay', label: '截止游戏天数', type: 'number' as const, required: true, placeholder: text(flag.dueDay ?? '') },
                                        ...(flag.kind === 'money_gte' ? [{ key: 'value', label: '资金目标', type: 'number' as const, placeholder: text(flag.value ?? '') }] : [])] }]),
                                { id: 'review.flag', label: '不收', tone: 'danger' as const, params: { reviewId: review.review!.reviewId, id: flag.id, decision: 'reject' } },
                            ] : [] })) },
                    { kind: 'table', title: '承诺账本', empty: '没有主播承诺', columns: [{ key: 'id', label: 'ID' }, { key: 'text', label: '原话' }, { key: 'kind', label: '规则' },
                        { key: 'dueDay', label: '截止天' }, { key: 'status', label: '状态' }, { key: 'evidence', label: '世界证据' }],
                        rows: workspace.motivation.commitments().filter(flag => flag.owner === 'user').map(flag => ({ cells: { id: flag.id, text: flag.text,
                            kind: flag.criterion?.kind ?? null, dueDay: adapter.season.deadline(flag.id), status: flag.status, evidence: flag.evidenceRef ?? null } })) },
                ],
            },
            {
                id: 'events', title: '事件覆盖', sections: [
                    { kind: 'table', title: '当前能产生的事件', columns: [{ key: 'event', label: '事件' }, { key: 'source', label: '来源' }],
                        rows: Object.entries(EVENT_SOURCES).map(([event, source]) => ({ cells: { event, source } })) },
                    { kind: 'text', title: '缺失事件', text: MISSING_EVENTS },
                ],
            },
        ]
    }

    const act = (actionId: string, params: Record<string, ConsoleValue>, actorId: string): { message: string } => {
        const id = text(params.id)
        switch (actionId) {
            case 'world.approve':
            case 'world.reject': {
                const item = adapter.decideWorldEffect(id, actionId === 'world.approve' ? 'approve' : 'reject', actorId)
                return { message: `${item.id} ${item.status === 'approved' ? '已批准并生效' : '已拒绝'}` }
            }
            case 'world.approveAll': {
                const pending = adapter.worldReview.list('pending')
                for (const item of pending) adapter.decideWorldEffect(item.id, 'approve', actorId)
                return { message: `已按顺序批准 ${pending.length} 项` }
            }
            case 'world.mode': {
                if (params.mode !== 'review' && params.mode !== 'auto') throw new Error('mode 必须是 review 或 auto')
                adapter.worldReview.setMode(params.mode, actorId)
                return { message: params.mode === 'review' ? '已切到审批模式' : '已切到自动模式' }
            }
            case 'episode.close': {
                const review = adapter.closeEpisode(`console-close:${Date.now()}`)
                if (!review) throw new Error('当前没有进行中的一期')
                return { message: `已收尾，生成 ${review.reviewId}：候选记忆 ${review.memories.length} 条，flag 候选 ${review.flags.length} 条` }
            }
            case 'review.memory': {
                if (params.decision !== 'accept' && params.decision !== 'reject') throw new Error('decision 无效')
                const result = adapter.applyReview({ reviewId: text(params.reviewId), memories: [{ id, decision: params.decision }] }, false)
                if (result.rejected.length) throw new Error(result.rejected.join('；'))
                return { message: params.decision === 'accept' ? '已写入长期记忆' : '已拒绝' }
            }
            case 'review.flag': {
                if (params.decision !== 'accept' && params.decision !== 'reject') throw new Error('decision 无效')
                const number = (value: ConsoleValue | undefined) => value === undefined || value === null || value === '' ? undefined : Number(value)
                const dueDay = number(params.dueDay)
                const value = number(params.value)
                const result = adapter.applyReview({ reviewId: text(params.reviewId), flags: [{ id, decision: params.decision,
                    ...(dueDay !== undefined ? { dueDay } : {}), ...(value !== undefined ? { value } : {}) }] }, false)
                if (result.rejected.length) throw new Error(result.rejected.join('；'))
                return { message: params.decision === 'accept' ? '已收为承诺' : '已不收' }
            }
            case 'review.finish': {
                const review = adapter.season.pendingReview()
                if (!review) throw new Error('没有待完成的审核')
                adapter.applyReview({ reviewId: review.reviewId }, true)
                return { message: `${review.reviewId} 审核已完成` }
            }
            default:
                throw new Error(`未知操作 ${actionId}`)
        }
    }

    return { id: 'probably-stolen', title: 'Probably Stolen · 绝命鲸师', panels, act }
}
