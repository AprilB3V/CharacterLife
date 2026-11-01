// CharacterLife owner console. All data is rendered with textContent; nothing from
// the server is ever inserted as HTML.
'use strict'

const state = { token: sessionStorage.getItem('cl-console-token') ?? '', instance: null, tab: 'semantics', plugins: [], timer: null, busy: false }
const $ = id => document.getElementById(id)

function el(tag, props = {}, children = []) {
    const node = document.createElement(tag)
    for (const [key, value] of Object.entries(props)) {
        if (value === undefined || value === null || value === false) continue
        if (key === 'class') node.className = value
        else if (key === 'text') node.textContent = value
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
        else node.setAttribute(key, value === true ? '' : value)
    }
    for (const child of [].concat(children)) if (child !== null && child !== undefined) node.append(child instanceof Node ? child : String(child))
    return node
}

function show(text, kind = '') {
    const node = $('status')
    node.textContent = text
    node.className = `status ${kind}`
}

async function api(path, options = {}) {
    const response = await fetch(`/api${path}`, {
        ...options,
        headers: { authorization: `Bearer ${state.token}`, ...(options.body ? { 'content-type': 'application/json' } : {}) },
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(data?.error?.message ?? `HTTP ${response.status}`)
    return data
}

const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) })
const fmt = value => value === null || value === undefined || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value)

/* ---------------------------------------------------------------- building blocks */

function kv(items) {
    return el('dl', { class: 'kv' }, items.flatMap(([label, value]) => [el('dt', { text: label }), el('dd', { text: fmt(value) })]))
}

function table(columns, rows, empty = '暂无') {
    if (!rows.length) return el('div', { class: 'empty', text: empty })
    const head = el('tr', {}, columns.map(column => el('th', { text: column.label })))
    const body = rows.map(row => el('tr', {}, columns.map(column => {
        const value = typeof column.value === 'function' ? column.value(row) : row[column.key]
        return value instanceof Node ? el('td', { class: column.class }, value) : el('td', { class: column.class, text: fmt(value) })
    })))
    return el('div', { class: 'scroll' }, el('table', {}, [el('thead', {}, head), el('tbody', {}, body)]))
}

function chips(values, kind = '') {
    return el('div', { class: 'chips' }, values.map(value => el('span', { class: `chip ${kind}`, text: value })))
}

function card(title, children, note) {
    return el('section', { class: 'card' }, [el('h2', {}, [title, note ? el('small', { text: note }) : null]), ...[].concat(children)])
}

async function askFields(title, fields) {
    if (!fields?.length) return {}
    const dialog = $('dialog')
    $('dialog-title').textContent = title
    const box = $('dialog-fields')
    box.replaceChildren(...fields.map(field => el('label', {}, [field.label,
        el('input', { name: field.key, type: field.type === 'number' ? 'number' : 'text', required: field.required, placeholder: field.placeholder ?? '' })])))
    dialog.showModal()
    return new Promise(resolve => {
        const done = ok => {
            dialog.close()
            $('dialog-form').onsubmit = null
            $('dialog-cancel').onclick = null
            if (!ok) return resolve(null)
            const values = {}
            for (const field of fields) {
                const raw = box.querySelector(`[name="${field.key}"]`).value.trim()
                values[field.key] = raw === '' ? null : field.type === 'number' ? Number(raw) : raw
            }
            resolve(values)
        }
        $('dialog-form').onsubmit = event => { event.preventDefault(); done(true) }
        $('dialog-cancel').onclick = () => done(false)
    })
}

async function run(label, fn) {
    if (state.busy) return
    state.busy = true
    try {
        show(`${label}…`)
        const result = await fn()
        show(result?.message ?? `${label}：完成`, 'ok')
        await render()
    } catch (error) {
        show(`${label}失败：${error.message}`, 'error')
    } finally {
        state.busy = false
    }
}

/* ---------------------------------------------------------------- views */

async function viewSemantics() {
    const s = await api(`/instances/${state.instance}/semantics`)
    const persona = s.self.persona
    const condition = s.self.condition
    const facts = Object.entries(s.situation.facts ?? {}).filter(([key]) => !key.startsWith('itemName.'))
    const inventory = Object.entries(s.situation.inventory ?? {})
    return el('div', { class: 'grid' }, [
        card('Self · 我是谁', [
            kv([['名字', `${persona.name}（${persona.id} v${persona.version}）`], ['身份', persona.occupation], ['说话风格', persona.speechStyle]]),
            el('h3', { text: '性格' }), chips(persona.traits ?? []),
            el('h3', { text: '内容边界' }), chips(persona.contentBoundaries ?? [], 'warn'),
            el('h3', { text: '身心状况' }), kv([
                ['心情', condition.mood?.label ? `${condition.mood.label}（效价 ${condition.mood.valence ?? '—'}，唤醒 ${condition.mood.arousal ?? '—'}）` : condition.mood],
                ['活动', condition.activity?.label ?? condition.activity], ['精力', condition.energy]]),
        ], '只读人格'),
        card('Situation · 我在什么处境', [
            kv([['截至', s.situation.asOfSim], ['位置', s.situation.location], ['在场', (s.situation.present ?? []).join('、')], ['可做', (s.situation.affords ?? []).join('、')]]),
            el('h3', { text: `事实（${facts.length}）` }),
            table([{ key: 0, label: '键' }, { key: 1, label: '值' }], facts, '没有事实'),
            el('h3', { text: `库存（${inventory.length}）` }),
            table([{ key: 0, label: '物品' }, { key: 1, label: '数量' }], inventory, '没有库存'),
        ], '由观察推出的信念'),
        card('Observation · 我刚感知到什么', [
            table([{ key: 'seq', label: '#' }, { key: 'source', label: '来源' }, { key: 'text', label: '内容' },
                { label: '事件', value: row => row.events.length ? chips(row.events) : '—' }, { key: 'ref', label: '出处', class: 'mono' }],
            s.observation.latest, '还没有观察'),
        ], `最近 ${s.observation.latest.length} 条 / 共 ${s.observation.lastSeq}`),
        card('Memory · 我记得什么', [
            kv([['有效记忆', s.memory.total], ['已软删除', s.memory.deleted], ['待审（模型提出）', s.review.memories]]),
            el('h3', { text: '按类型 / 状态 / 来源' }),
            chips(Object.entries(s.memory.byKind).map(([key, value]) => `${key} ${value}`)),
            chips(Object.entries(s.memory.byStatus).map(([key, value]) => `${key} ${value}`)),
            chips(Object.entries(s.memory.byOrigin).map(([key, value]) => `${key} ${value}`)),
            el('h3', { text: '关系认识' }),
            kv([['阶段', s.memory.relationship.stage], ['熟悉度', s.memory.relationship.familiarity], ['信任', s.memory.relationship.trust],
                ['里程碑', (s.memory.relationship.milestones ?? []).length]]),
        ], '带出处的记忆'),
        card('Motivation · 我想要什么', [
            el('h3', { text: '目标' }),
            table([{ key: 'id', label: 'ID', class: 'mono' }, { key: 'title', label: '目标' }, { key: 'kind', label: '类型' }, { key: 'progress', label: '进度' }], s.motivation.goals, '没有目标'),
            el('h3', { text: '内驱力' }),
            table([{ key: 'label', label: '驱力' }, { key: 'value', label: '值' }, { key: 'threshold', label: '阈值' }, { key: 'urgent', label: '紧迫' }], s.motivation.drives, '未配置内驱力'),
            el('h3', { text: '承诺账本' }),
            table([{ key: 'id', label: 'ID', class: 'mono' }, { key: 'text', label: '内容' }, { key: 'status', label: '状态' }, { key: 'evidenceRef', label: '证据', class: 'mono' }],
                s.motivation.commitments, '没有承诺'),
        ]),
        card('Affordance · 我能做什么', Object.entries(s.affordance).flatMap(([channel, options]) => [
            el('h3', { text: `${channel}（${options.length}）` }),
            options.length ? chips(options.map(option => `${option.label} ${option.verb}${option.target ? `(${option.target})` : ''}`)) : el('div', { class: 'empty', text: '空：此渠道没有可做的动作' }),
        ]), '各扩展登记的可行动作'),
    ])
}

async function viewMemories() {
    const params = new URLSearchParams(location.hash.split('?')[1] ?? '')
    const q = params.get('q') ?? ''
    const tag = params.get('tag') ?? ''
    const deleted = params.get('deleted') === '1'
    const query = new URLSearchParams({ limit: '500', ...(q ? { q } : {}), ...(tag ? { tag } : {}), ...(deleted ? { deleted: '1' } : {}) })
    const memories = await api(`/instances/${state.instance}/memories?${query}`)
    const search = el('input', { placeholder: '关键词', value: q })
    const tagInput = el('input', { placeholder: '标签，如 grudge', value: tag })
    const showDeleted = el('input', { type: 'checkbox', checked: deleted })
    const apply = () => {
        const next = new URLSearchParams({ ...(search.value ? { q: search.value } : {}), ...(tagInput.value ? { tag: tagInput.value } : {}), ...(showDeleted.checked ? { deleted: '1' } : {}) })
        location.hash = `memories?${next}`
    }
    return card('记忆', [
        el('form', { class: 'toolbar', onsubmit: event => { event.preventDefault(); apply() } }, [search, tagInput,
            el('label', { class: 'toggle' }, [showDeleted, '含已删除']), el('button', { type: 'submit', text: '筛选' })]),
        table([
            { key: 'id', label: 'ID', class: 'mono' }, { key: 'title', label: '标题' }, { key: 'content', label: '内容' },
            { label: '类型/状态', value: row => chips([row.kind, row.status, row.origin, row.trust], row.status === 'fact' ? 'good' : 'warn') },
            { label: '标签', value: row => chips(row.tags) }, { key: 'sourceRef', label: '出处', class: 'mono' },
            { label: '', class: 'actions', value: row => row.deletedAtSim !== null ? el('span', { class: 'muted', text: '已删除' })
                : el('button', { class: 'small danger', text: '软删除', onclick: () => {
                    if (confirm(`软删除记忆「${row.title}」？审计会保留记录。`)) run('删除记忆', () => post(`/instances/${state.instance}/memories/${encodeURIComponent(row.id)}/delete`, {}))
                } }) },
        ], memories, '没有符合条件的记忆'),
    ], `${memories.length} 条`)
}

async function viewReview() {
    const items = await api(`/instances/${state.instance}/memory-review`)
    const pending = items.filter(item => item.status === 'pending')
    const decided = items.filter(item => item.status !== 'pending').slice(0, 50)
    const decide = (item, decision) => run(decision === 'approve' ? '批准记忆' : '拒绝记忆',
        () => post(`/instances/${state.instance}/memory-review/${encodeURIComponent(item.id)}`, { decision }))
    const columns = [
        { key: 'id', label: 'ID', class: 'mono' }, { label: '标题', value: row => row.input.title }, { label: '内容', value: row => row.input.content },
        { label: '类型/状态', value: row => chips([row.input.kind, row.input.status, row.input.origin]) },
        { label: '标签', value: row => chips(row.input.tags ?? []) }, { key: 'sourceRef', label: '对话轮', class: 'mono' },
    ]
    return el('div', {}, [
        card('待审记忆', [
            el('p', { class: 'muted', text: '模型每轮提出的记忆先停在这里。批准后按原聊天身份与 Policy 写入；运行时依据世界事件写入的记忆不经过此队列。' }),
            table([...columns, { label: '', class: 'actions', value: row => el('span', {}, [
                el('button', { class: 'small primary', text: '批准', onclick: () => decide(row, 'approve') }),
                el('button', { class: 'small danger', text: '拒绝', onclick: () => decide(row, 'reject') })]) }], pending, '没有待审记忆'),
        ], `${pending.length} 条`),
        card('最近已处理', table([...columns, { key: 'status', label: '结果' }, { key: 'note', label: '备注' }], decided, '暂无')),
    ])
}

async function viewAudit() {
    const events = await api(`/instances/${state.instance}/audit?limit=300`)
    return card('审计（本进程内）', table([{ key: 'seq', label: '#' }, { key: 'atWall', label: '时间', class: 'mono' }, { key: 'type', label: '类型' },
        { key: 'actor', label: '执行者' }, { key: 'summary', label: '摘要' }, { label: '数据', class: 'mono', value: row => JSON.stringify(row.data).slice(0, 300) }], events, '暂无审计'),
    '重启后从头计数；持久记录见账本与事件日志')
}

function renderAction(pluginId, action) {
    return el('button', { class: `small ${action.tone ?? ''}`, text: action.label, onclick: async () => {
        if (action.confirm && !confirm(action.confirm)) return
        const values = await askFields(action.label, action.fields)
        if (values === null) return
        run(action.label, () => post(`/instances/${state.instance}/plugins/${encodeURIComponent(pluginId)}/actions/${encodeURIComponent(action.id)}`,
            { params: { ...(action.params ?? {}), ...values } }))
    } })
}

function renderSection(pluginId, section) {
    const head = el('h3', { text: section.title })
    if (section.kind === 'fields') return [head, kv(section.items.map(item => [item.label, item.value]))]
    if (section.kind === 'text') return [head, el('pre', { class: 'text', text: section.text })]
    if (section.kind === 'actions') return [head, el('div', { class: 'toolbar' }, section.actions.map(action => renderAction(pluginId, action)))]
    const hasActions = section.rows.some(row => row.actions?.length)
    const columns = [...section.columns.map(column => ({ label: column.label, value: row => row.cells[column.key] })),
        ...(hasActions ? [{ label: '', class: 'actions', value: row => el('span', {}, (row.actions ?? []).map(action => renderAction(pluginId, action))) }] : [])]
    return [head, table(columns, section.rows, section.empty)]
}

async function viewPlugin(pluginId, panelId) {
    const plugin = await api(`/instances/${state.instance}/plugins/${encodeURIComponent(pluginId)}`)
    updatePluginBadges(plugin)
    const panel = plugin.panels.find(item => item.id === panelId) ?? plugin.panels[0]
    if (!panel) return el('p', { class: 'hint', text: '插件没有面板' })
    return card(panel.title, panel.sections.flatMap(section => renderSection(plugin.id, section)), plugin.title)
}

/* ---------------------------------------------------------------- shell */

function updatePluginBadges(plugin) {
    for (const panel of plugin.panels) {
        const badge = document.querySelector(`[data-tab="plugin:${plugin.id}:${panel.id}"] .badge`)
        if (badge) { badge.textContent = String(panel.badge ?? 0); badge.hidden = !panel.badge }
    }
}

async function refreshBadges() {
    const semantics = await api(`/instances/${state.instance}/semantics?observations=1`)
    const review = document.querySelector('[data-tab="review"] .badge')
    if (review) { review.textContent = String(semantics.review.memories); review.hidden = !semantics.review.memories }
    for (const plugin of semantics.plugins) updatePluginBadges(await api(`/instances/${state.instance}/plugins/${encodeURIComponent(plugin.id)}`))
}

async function buildTabs() {
    const semantics = await api(`/instances/${state.instance}/semantics?observations=1`)
    const plugins = await Promise.all(semantics.plugins.map(plugin => api(`/instances/${state.instance}/plugins/${encodeURIComponent(plugin.id)}`)))
    state.plugins = plugins
    const tab = (id, label, badge) => el('button', { role: 'tab', 'data-tab': id, 'aria-selected': String(state.tab === id),
        onclick: () => { location.hash = id } }, [label, el('span', { class: 'badge', hidden: !badge, text: String(badge ?? 0) })])
    $('tabs').replaceChildren(
        tab('semantics', '六语义'), tab('memories', '记忆'), tab('review', '待审记忆', semantics.review.memories), tab('audit', '审计'),
        ...plugins.flatMap(plugin => [el('span', { class: 'group', text: `插件 · ${plugin.title}` }),
            ...plugin.panels.map(panel => tab(`plugin:${plugin.id}:${panel.id}`, panel.title, panel.badge))]),
    )
}

async function render() {
    if (!state.instance) return
    state.tab = (location.hash.slice(1).split('?')[0]) || 'semantics'
    for (const node of document.querySelectorAll('[data-tab]')) node.setAttribute('aria-selected', String(node.dataset.tab === state.tab))
    try {
        let view
        if (state.tab === 'semantics') view = await viewSemantics()
        else if (state.tab === 'memories') view = await viewMemories()
        else if (state.tab === 'review') view = await viewReview()
        else if (state.tab === 'audit') view = await viewAudit()
        else if (state.tab.startsWith('plugin:')) {
            const [, pluginId, panelId] = state.tab.split(':')
            view = await viewPlugin(pluginId, panelId)
        } else view = el('p', { class: 'hint', text: '未知页面' })
        // Keep the open dialog and focus stable during auto-refresh.
        if (!$('dialog').open) $('view').replaceChildren(view)
        await refreshBadges()
    } catch (error) {
        show(error.message, 'error')
    }
}

async function connect() {
    try {
        const instances = await api('/instances')
        const select = $('instance')
        select.replaceChildren(...instances.map(item => el('option', { value: item.id, text: `${item.label || item.id} · ${item.templateId}@${item.templateVersion} · ${item.worldId}` })))
        if (!instances.length) { show('没有实例', 'error'); return }
        state.instance = instances.some(item => item.id === state.instance) ? state.instance : instances[0].id
        select.value = state.instance
        await buildTabs()
        await render()
        show(`已连接 · ${instances.length} 个实例`, 'ok')
        schedule()
    } catch (error) {
        show(error.message, 'error')
    }
}

function schedule() {
    clearInterval(state.timer)
    if ($('auto').checked) state.timer = setInterval(async () => {
        if (state.busy || document.hidden || $('dialog').open) return
        if (document.activeElement?.closest?.('.toolbar')) return
        await render()
    }, 3000)
}

$('token').value = state.token
$('login').addEventListener('submit', event => {
    event.preventDefault()
    state.token = $('token').value.trim()
    sessionStorage.setItem('cl-console-token', state.token)
    connect()
})
$('instance').addEventListener('change', async event => { state.instance = event.target.value; await buildTabs(); await render() })
$('refresh').addEventListener('click', async () => { if (state.instance) { await buildTabs(); await render() } })
$('auto').addEventListener('change', schedule)
window.addEventListener('hashchange', render)
if (state.token) connect()
