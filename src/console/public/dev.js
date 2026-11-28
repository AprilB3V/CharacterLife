// Developer mode: add / edit / delete controls on the six-semantics and memory pages.
// Loaded before app.js; uses its helpers (el, askFields, run, post, state) at call time.
// Every edit goes to /dev/<op>, which writes through the kernel Policy as the owner and is audited.
'use strict'

const devState = { on: localStorage.getItem('cl-console-dev') === '1' }
const devOn = () => devState.on

function devEdit(op, body) {
    return post(`/instances/${state.instance}/dev/${op}`, body)
}

/** A small button that asks for fields (optional) and sends one dev edit. */
function devButton(label, op, opts = {}) {
    return el('button', { type: 'button', class: `small dev ${opts.tone ?? ''}`, text: label, title: opts.title ?? '', onclick: async () => {
        if (opts.confirm && !confirm(opts.confirm)) return
        const values = opts.fields ? await askFields(opts.dialogTitle ?? label, opts.fields, opts.note) : {}
        if (values === null) return
        const body = { ...(opts.extra ?? {}), ...values }
        for (const key of Object.keys(body)) if (body[key] === null) delete body[key]
        run(opts.dialogTitle ?? label, () => devEdit(op, body))
    } })
}

const devBar = (...buttons) => devOn() ? el('div', { class: 'devbar' }, buttons.filter(Boolean)) : null
const devNote = text => devOn() ? el('p', { class: 'devnote', text }) : null
/** Extra table column with per-row dev buttons. */
const devColumn = render => devOn() ? [{ label: '', class: 'actions', value: row => el('span', {}, render(row)) }] : []

/* ---------------------------------------------------------------- field sets */

const MEMORY_FIELDS = (row = {}) => [
    { key: 'title', label: '标题', required: true, value: row.title },
    { key: 'content', label: '内容', type: 'textarea', required: true, value: row.content },
    { key: 'kind', label: '类型', value: row.kind ?? 'episodic', options: [['episodic', '经历 episodic'], ['user', '关于用户 user']] },
    { key: 'status', label: '认识状态', value: row.status ?? 'fact', options: [['fact', '事实 fact'], ['speculation', '推测 speculation'], ['fiction', '虚构 fiction']] },
    { key: 'origin', label: '来源', value: row.origin ?? 'import', options: ['import', 'user_confirmed', 'user_message', 'character_message', 'runtime_event', 'character_inference'] },
    { key: 'salience', label: '显著度 0–1', type: 'number', step: 'any', min: 0, max: 1, value: row.salience ?? 0.5 },
    { key: 'tags', label: '标签（逗号分隔）', value: (row.tags ?? []).join(', ') },
]

const GOAL_FIELDS = (row = {}) => [
    { key: 'title', label: '目标', required: true, value: row.title },
    { key: 'kind', label: '类型', value: row.kind ?? 'personal', options: [['personal', '个人 personal'], ['relational', '关系 relational']] },
    { key: 'progress', label: '进度 0–1', type: 'number', step: 'any', min: 0, max: 1, value: row.progress ?? 0 },
]

/* ---------------------------------------------------------------- per-semantic controls */

function devSelf(condition) {
    return [
        devBar(devButton('编辑身心状况', 'condition', { fields: [
            { key: 'mood', label: '心情', value: condition.mood?.label ?? '' },
            { key: 'valence', label: '效价 -1–1', type: 'number', step: 'any', min: -1, max: 1, value: condition.mood?.valence },
            { key: 'arousal', label: '唤醒 0–1', type: 'number', step: 'any', min: 0, max: 1, value: condition.mood?.arousal },
            { key: 'energy', label: '精力 0–1', type: 'number', step: 'any', min: 0, max: 1, value: condition.energy },
            { key: 'activity', label: '活动', value: condition.activity?.label ?? '' },
        ] })),
        devNote('人格（名字、性格、边界）来自角色模板并受内容哈希保护，这里只读；改人设需升模板版本。'),
    ]
}

function devSituation() {
    return [
        devBar(
            devButton('设定位置', 'location', { fields: [{ key: 'location', label: '位置', required: true }] }),
            devButton('添加事实', 'fact-set', { fields: [{ key: 'key', label: '键', required: true, placeholder: '如 weather' }, { key: 'value', label: '值', required: true, hint: 'true/false 与数字会按类型保存' }] }),
            devButton('设定库存', 'inventory-set', { fields: [{ key: 'item', label: '物品', required: true }, { key: 'count', label: '数量', type: 'number', min: 0, required: true }] }),
        ),
        devNote('处境与观察只存在本进程内存中，重启后由世界观察重建。'),
    ]
}

const devFactActions = row => [
    devButton('改', 'fact-set', { extra: { key: row[0] }, dialogTitle: `修改事实 ${row[0]}`, fields: [{ key: 'value', label: '值', required: true, value: row[1] }] }),
    devButton('删', 'fact-delete', { tone: 'danger', extra: { key: row[0] }, confirm: `删除事实「${row[0]}」？` }),
]

const devInventoryActions = row => [
    devButton('改', 'inventory-set', { extra: { item: row[0] }, dialogTitle: `修改库存 ${row[0]}`, fields: [{ key: 'count', label: '数量', type: 'number', min: 0, required: true, value: row[1] }] }),
    devButton('删', 'inventory-delete', { tone: 'danger', extra: { item: row[0] }, confirm: `移除物品「${row[0]}」？` }),
]

function devObservation() {
    return [devBar(devButton('注入观察', 'observation-add', { fields: [
        { key: 'text', label: '感知文本', type: 'textarea', required: true, placeholder: '如：窗外开始下雨了' },
        { key: 'events', label: '事件（逗号分隔，可空）', placeholder: '如 rain_started' },
    ], note: '以运行时身份追加一条可信观察，只在本进程内。' }))]
}

function devMemory(relationship) {
    return [devBar(
        devButton('新增记忆', 'memory-add', { fields: MEMORY_FIELDS(), note: '以主人身份写入；含注入特征的文本仍会被降级为不可信。' }),
        devButton('编辑关系', 'relationship', { fields: [
            { key: 'stage', label: '阶段', value: relationship.stage, options: ['stranger', 'acquaintance', 'familiar', 'friend', 'close'] },
            { key: 'familiarity', label: '熟悉度 0–100', type: 'number', min: 0, max: 100, value: relationship.familiarity },
            { key: 'trust', label: '信任 0–100', type: 'number', min: 0, max: 100, value: relationship.trust },
        ] }),
    )]
}

const devMemoryActions = row => row.deletedAtSim !== null ? [] : [
    devButton('编辑', 'memory-edit', { extra: { id: row.id }, dialogTitle: `编辑记忆 ${row.id}`, fields: MEMORY_FIELDS(row),
        note: '保存后旧版本软删除，新记忆注明取代关系，审计保留全过程。' }),
]

const devGoalActions = row => [
    devButton('改', 'goal-upsert', { extra: { id: row.id }, dialogTitle: '修改目标', fields: GOAL_FIELDS(row) }),
    devButton('删', 'goal-delete', { tone: 'danger', extra: { id: row.id }, confirm: `删除目标「${row.title}」？` }),
]

const devDriveActions = row => [
    devButton('设定', 'drive', { extra: { id: row.name }, dialogTitle: `设定驱力 ${row.label}`, fields: [{ key: 'value', label: '当前水平 0–1', type: 'number', step: 'any', min: 0, max: 1, required: true, value: row.value }] }),
]

const devCommitmentActions = row => row.status !== 'open' ? [] : [
    devButton('兑现', 'commitment-settle', { extra: { id: row.id, status: 'kept' } }),
    devButton('未兑现', 'commitment-settle', { tone: 'danger', extra: { id: row.id, status: 'broken' }, confirm: '把这条承诺标记为未兑现？' }),
]

const devGoalBar = () => devBar(devButton('添加目标', 'goal-upsert', { fields: GOAL_FIELDS() }))
