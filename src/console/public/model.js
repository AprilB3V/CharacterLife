// "模型接入": pick a vendor preset, fill a key, test, save and switch the live chat model.
// Loaded before app.js; uses its helpers (el, card, kv, chips, api, post, show, run) at call time.
// Keys typed here go to the server once and are never sent back; the list shows only the last 4 chars.
'use strict'

const modelState = { draft: null, models: [], result: null, info: null }

const KEY_SOURCE = { stored: '已保存在本机', env: '来自环境变量', missing: '缺少 Key', 'not-needed': '无需 Key' }
const REGION = { cn: '国内', global: '海外', local: '本机' }

function blankDraft(preset) {
    return { id: null, preset: preset.id, label: '', baseUrl: preset.baseUrl, model: preset.model, apiKey: '',
        keyMode: preset.keyOptional ? 'none' : 'input', apiKeyEnv: preset.keyEnv, reasoning: '', timeoutMs: '' }
}

function draftFromProfile(profile) {
    return { id: profile.id, preset: profile.preset, label: profile.label, baseUrl: profile.baseUrl, model: profile.model, apiKey: '',
        keyMode: profile.apiKeyEnv ? 'env' : profile.keySource === 'not-needed' ? 'none' : 'input', apiKeyEnv: profile.apiKeyEnv ?? '',
        reasoning: profile.reasoning ?? '', timeoutMs: profile.timeoutMs ?? '' }
}

/** Request body for test / models / save; an empty key field means "keep or resolve on the server". */
function draftBody(draft) {
    return {
        ...(draft.id ? { id: draft.id } : {}), preset: draft.preset, label: draft.label, baseUrl: draft.baseUrl, model: draft.model,
        ...(draft.keyMode === 'input' && draft.apiKey ? { apiKey: draft.apiKey } : {}),
        ...(draft.keyMode === 'env' && draft.apiKeyEnv ? { apiKeyEnv: draft.apiKeyEnv } : {}),
        ...(draft.reasoning ? { reasoning: draft.reasoning } : {}),
        ...(draft.timeoutMs ? { timeoutMs: Number(draft.timeoutMs) } : {}),
    }
}

function updateModelBanner(info) {
    const banner = $('banner')
    modelState.info = info
    const mock = info.current.mock
    if (banner.hidden === Boolean(mock)) {
        banner.hidden = !mock
        banner.replaceChildren(...(mock ? [
            el('b', { text: '还没接入模型' }), ' 角色现在用的是模拟回复。',
            el('a', { href: '#model', text: '去「模型接入」选一家厂商 →' }),
        ] : []))
    }
    const badge = document.querySelector('[data-tab="model"] .badge')
    if (badge) { badge.textContent = '!'; badge.hidden = !mock }
}

async function refreshModelBanner() {
    try { updateModelBanner(await api('/model')) }
    catch { $('banner').hidden = true }
}

function presetGrid(info, draft) {
    return el('div', { class: 'presets', role: 'radiogroup', 'aria-label': '模型厂商' }, info.presets.map(preset => el('button', {
        type: 'button', class: 'preset', role: 'radio', 'aria-checked': String(draft.preset === preset.id),
        onclick: () => {
            // Switching vendor resets address and model, but keeps a label the user typed.
            modelState.draft = { ...blankDraft(preset), id: draft.id, label: draft.label }
            modelState.models = []
            modelState.result = null
            rerenderModel()
        },
    }, [el('b', { text: preset.label }), el('span', { text: preset.blurb }), el('i', { text: REGION[preset.region] ?? '' })])))
}

function labeled(label, control, hint) {
    return el('label', { class: 'form-row' }, [el('span', { class: 'form-label', text: label }), control, hint ? el('small', { class: 'muted', text: hint }) : null])
}

function bind(input, draft, key) {
    input.value = draft[key] ?? ''
    input.addEventListener('input', () => { draft[key] = input.value.trim() })
    return input
}

function modelForm(info, draft) {
    const preset = info.presets.find(item => item.id === draft.preset) ?? info.presets.at(-1)
    const datalist = el('datalist', { id: 'model-options' }, modelState.models.map(id => el('option', { value: id })))
    const modelInput = bind(el('input', { list: 'model-options', placeholder: preset.model || '点右侧按钮获取，或手动填写' }), draft, 'model')
    const keyMode = el('select', { 'aria-label': 'Key 来源' }, [
        el('option', { value: 'input', text: '直接填写（保存在本机）' }),
        el('option', { value: 'env', text: '读取环境变量（不落盘）' }),
        ...(preset.keyOptional ? [el('option', { value: 'none', text: '不需要 Key' })] : []),
    ])
    keyMode.value = draft.keyMode
    keyMode.addEventListener('change', () => { draft.keyMode = keyMode.value; rerenderModel() })
    const editing = info.profiles.find(item => item.id === draft.id)
    const keyInput = draft.keyMode === 'input'
        ? bind(el('input', { type: 'password', autocomplete: 'new-password',
            placeholder: editing?.keyHint ? `留空沿用 ${editing.keyHint}` : preset.keyEnv ? `留空则尝试环境变量 ${preset.keyEnv}` : 'sk-…' }), draft, 'apiKey')
        : draft.keyMode === 'env' ? bind(el('input', { placeholder: preset.keyEnv || 'MY_API_KEY' }), draft, 'apiKeyEnv') : null
    const reasoning = el('select', {}, [['', '自动（按模型的已验证默认值）'], ['default', '不发送推理字段'], ['disabled', '关闭思考 disabled'], ['low', '低 low'], ['minimal', '最低 minimal']]
        .map(([value, text]) => el('option', { value, text })))
    reasoning.value = draft.reasoning
    reasoning.addEventListener('change', () => { draft.reasoning = reasoning.value })

    const result = modelState.result
    const busy = label => el('span', { class: 'muted', text: `${label}…` })
    const call = async (label, fn) => {
        modelState.result = { pending: true, label }
        rerenderModel()
        try { modelState.result = { ok: true, ...(await fn()) } }
        catch (error) { modelState.result = { ok: false, message: error.message } }
        rerenderModel()
    }
    return el('div', { class: 'model-form' }, [
        el('h3', { text: '1 · 选厂商' }),
        presetGrid(info, draft),
        el('h3', { text: '2 · 填写连接' }),
        el('div', { class: 'form-grid' }, [
            labeled('API 地址', bind(el('input', { placeholder: 'https://…/v1' }), draft, 'baseUrl'), 'OpenAI 兼容地址，末尾不用加 /chat/completions'),
            labeled('模型', el('div', { class: 'inline' }, [modelInput, datalist,
                el('button', { type: 'button', class: 'small', text: '获取模型列表', onclick: () => call('获取模型列表', async () => {
                    const { models } = await post('/model/models', draftBody(draft))
                    modelState.models = models
                    return { message: models.length ? `找到 ${models.length} 个模型，点模型输入框选择` : '接口没有返回模型，请手动填写' }
                }) })])),
            labeled('Key 来源', keyMode),
            keyInput ? labeled(draft.keyMode === 'env' ? '环境变量名' : 'API Key', keyInput,
                draft.keyMode === 'env' ? '服务进程启动时的环境变量；Key 不会写入配置文件' : '只发给本机后台，保存后页面不再显示') : null,
            preset.keyUrl ? el('p', { class: 'form-tip' }, [el('a', { href: preset.keyUrl, target: '_blank', rel: 'noopener noreferrer', text: `没有 Key？去 ${preset.label} 申请 ↗` })]) : null,
            labeled('显示名称', bind(el('input', { placeholder: `${preset.label} · ${draft.model || '模型'}` }), draft, 'label')),
        ]),
        fold('model:advanced', '高级选项', el('div', { class: 'form-grid' }, [
            labeled('推理强度', reasoning, '只对支持的厂商生效；不确定就保持自动'),
            labeled('超时（毫秒）', bind(el('input', { type: 'number', min: 3000, max: 600000, placeholder: '60000' }), draft, 'timeoutMs')),
        ])),
        el('h3', { text: '3 · 测试并启用' }),
        el('div', { class: 'toolbar' }, [
            el('button', { type: 'button', text: '测试连接', onclick: () => call('测试连接', async () => {
                const r = await post('/model/test', draftBody(draft))
                return { message: `连接成功 · ${r.model} · ${r.latencyMs} ms${r.reply ? ` · 回复「${r.reply}」` : ''}` }
            }) }),
            el('button', { type: 'button', text: '仅保存', onclick: () => call('保存', () => post('/model/profiles', draftBody(draft)).then(r => { modelState.draft.id = r.id; return r })) }),
            el('button', { type: 'button', class: 'primary', text: '保存并启用', onclick: () => call('保存并启用', () => post('/model/profiles', { ...draftBody(draft), activate: true }).then(r => { modelState.draft.id = r.id; return r })) }),
            draft.id ? el('button', { type: 'button', class: 'ghost', text: '新建另一个', onclick: () => { modelState.draft = blankDraft(preset); modelState.result = null; rerenderModel() } }) : null,
        ]),
        result ? (result.pending ? busy(result.label) : el('p', { class: `result ${result.ok ? 'ok' : 'error'}`, text: result.message ?? '完成' })) : null,
    ])
}

function profileList(info) {
    const rows = info.profiles.map(profile => {
        const active = info.active === profile.id
        return el('li', { class: `profile ${active ? 'active' : ''}` }, [
            el('div', { class: 'profile-main' }, [
                el('b', { text: profile.label }),
                active ? el('span', { class: 'chip good', text: '使用中' }) : null,
                el('div', { class: 'muted small', text: `${profile.model} · ${profile.baseUrl}` }),
                el('div', { class: 'small' }, [el('span', { class: `chip ${profile.keySource === 'missing' ? 'bad' : ''}`, text: `${KEY_SOURCE[profile.keySource]}${profile.keyHint ? ` ${profile.keyHint}` : ''}${profile.apiKeyEnv ? `（${profile.apiKeyEnv}）` : ''}` })]),
            ]),
            el('div', { class: 'profile-actions' }, [
                active ? null : el('button', { type: 'button', class: 'small primary', text: '启用', onclick: () => run('切换模型', () => post(`/model/profiles/${encodeURIComponent(profile.id)}/activate`, {})) }),
                el('button', { type: 'button', class: 'small', text: '编辑', onclick: () => { modelState.draft = draftFromProfile(profile); modelState.result = null; modelState.models = []; rerenderModel(); document.querySelector('.model-form')?.scrollIntoView({ behavior: 'smooth' }) } }),
                el('button', { type: 'button', class: 'small danger', text: '删除', onclick: () => { if (confirm(`删除连接「${profile.label}」？${active ? '删除后回到环境变量配置。' : ''}`)) run('删除连接', () => post(`/model/profiles/${encodeURIComponent(profile.id)}/delete`, {})) } }),
            ]),
        ])
    })
    return rows.length ? el('ul', { class: 'profiles' }, rows) : el('div', { class: 'empty', text: '还没有保存的连接。在右侧选一家厂商开始。' })
}

function viewModel(info) {
    if (!modelState.draft) {
        const active = info.profiles.find(item => item.id === info.active)
        modelState.draft = active ? draftFromProfile(active) : blankDraft(info.presets[0])
    }
    const c = info.current
    return el('div', { class: 'model-page' }, [
        el('div', { class: 'model-side' }, [
            card('正在使用', [
                el('div', { class: `now ${c.mock ? 'mock' : ''}` }, [el('b', { text: c.mock ? '模拟回复（未接模型）' : c.model }), el('span', { text: c.mock ? '选一家厂商接入真实模型' : c.name })]),
                kv([['来源', c.note], ...Object.entries(c.settings ?? {}).map(([key, value]) => [key, value])]),
                info.active && !info.locked ? el('button', { type: 'button', class: 'small ghost', text: '改用环境变量配置',
                    onclick: () => run('改用环境变量', () => post('/model/use-env', {})) }) : null,
                info.locked ? el('p', { class: 'muted', text: '本进程的模型由代码注入（测试 / 演示），后台不能切换。' }) : null,
            ], '切换后下一句对话起生效'),
            card('已保存的连接', profileList(info), info.writable ? '' : '只读：数据库在内存中'),
        ]),
        card(modelState.draft.id ? '编辑连接' : '新建连接', modelForm(info, modelState.draft), '任何 OpenAI 兼容接口'),
    ])
}

async function rerenderModel() {
    if (state.tab !== 'model' || $('dialog').open) return
    if (state.instance && location.hash.slice(1).split('?')[0] !== 'model') return
    await render()
}
