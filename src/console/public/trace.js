// Thought-trace and configuration views for the owner console.
// Loaded before app.js; uses its helpers (el, card, kv, table, chips, fmt, api) at call time.
'use strict'

const traceState = { selected: null, signature: '', open: new Set(), kind: '' }

const FALLBACK_LABELS = {
    broken_envelope: '结构化输出损坏 → 兜底句',
    injection_pushback: '注入回推句',
    empty_reply: '空白回复 → 兜底句',
    provider_error: '模型调用失败 → 兜底句',
    boundary_short_circuit: '内容边界短路（未调用模型）',
    context_budget_exceeded: '上下文预算不足（未调用模型）',
}

const timeOf = iso => {
    const date = new Date(iso)
    return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString('zh-CN', { hour12: false })
}
const clip = (text, n = 60) => !text ? '—' : text.length > n ? `${text.slice(0, n)}…` : text
const json = value => JSON.stringify(value, null, 2)

/** Collapsible block whose open state survives auto-refresh. */
function fold(key, summary, body, openByDefault = false) {
    const open = traceState.open.has(key) || (openByDefault && !traceState.open.has(`!${key}`))
    const node = el('details', { class: 'fold', open }, [el('summary', {}, summary), body])
    node.addEventListener('toggle', () => {
        traceState.open.delete(key); traceState.open.delete(`!${key}`)
        if (node.open && !openByDefault) traceState.open.add(key)
        if (!node.open && openByDefault) traceState.open.add(`!${key}`)
    })
    return node
}

// Runaway whitespace is invisible in a <pre>; count it so a stalled envelope is obvious.
const trailingBlank = raw => {
    const n = (raw ?? '').length - (raw ?? '').trimEnd().length
    return n ? `${n} 字（空格/制表符/换行）` : '无'
}
const pre = (text, cls = '') => el('pre', { class: `block ${cls}`, text: text ?? '—' })

/* ---------------------------------------------------------------- turn trace */

function turnStatus(trace) {
    const o = trace.outcome
    if (!o) return 'bad'
    if (o.error || o.fallback === 'provider_error' || o.fallback === 'broken_envelope') return 'bad'
    if (o.fallback || trace.attempts.length > 1 || o.rejected.length) return 'warn'
    return 'good'
}

/** The pipeline strip: one node per stage, coloured by what happened there. */
function turnFlow(trace) {
    const o = trace.outcome ?? {}
    const recall = trace.recall
    const recallCount = recall ? recall.pinned.length + recall.retrieved.length + recall.cued.length : 0
    const markers = trace.signals?.injectionMarkers ?? []
    const stages = [
        ['信号', (trace.signals?.intents ?? []).join('·') || '—', markers.length || trace.signals?.mentionsSystemAuthority ? 'warn' : 'good'],
        ['决策', trace.decision?.action ?? '—', trace.decision ? 'good' : 'skip'],
        ['回忆', `${recallCount} 条`, recall ? 'good' : 'skip'],
        ['上下文', trace.context ? `${trace.context.estPromptTokens}/${trace.context.budget}` : '—',
            !trace.context ? 'skip' : trace.context.degradation !== 'none' ? 'warn' : 'good'],
        ...trace.attempts.map((a, i) => [`调用 ${i + 1}`, a.parseError ? '解析失败' : `${a.latencyMs}ms`, a.parseError ? 'bad' : 'good']),
        ['信封', trace.envelope ? `${trace.envelope.proposals.length} 提议 · ${trace.envelope.memoryWrites.length} 记忆` : '—',
            trace.envelope ? 'good' : trace.attempts.length ? 'bad' : 'skip'],
        ['回复', o.fallback ? '兜底' : clip(o.reply, 10), o.fallback ? (turnStatus(trace) === 'bad' ? 'bad' : 'warn') : 'good'],
    ]
    if (!trace.attempts.length && trace.prompt === null && o.fallback) stages.splice(3, 0, ['短路', FALLBACK_LABELS[o.fallback] ?? o.fallback, 'warn'])
    return el('ol', { class: 'flow' }, stages.map(([name, detail, tone]) =>
        el('li', { class: `stage ${tone}` }, [el('b', { text: name }), el('span', { text: detail })])))
}

function memoryTable(rows, empty) {
    return table([{ key: 'id', label: 'ID', class: 'mono' }, { key: 'title', label: '标题' }, { key: 'kind', label: '类型' },
        { key: 'status', label: '状态' }, { key: 'detail', label: '依据', class: 'mono' }], rows, empty)
}

function turnDetail(trace) {
    const o = trace.outcome ?? {}
    const k = suffix => `${trace.id}:${suffix}`
    const signals = trace.signals ?? {}
    const { intents = [], injectionMarkers = [], ...otherSignals } = signals
    const sections = [
        turnFlow(trace),
        card('① 输入', [
            kv([['时间', trace.atWall], ['轮次', trace.turnId], ['身份', trace.identityKey], ['实例', trace.instanceId]]),
            pre(trace.input, 'quote'),
        ]),
        card('② 信号与行为决策', [
            el('h3', { text: '意图 / 注入特征' }),
            el('div', { class: 'chips' }, [...intents.map(i => el('span', { class: 'chip', text: i })),
                ...injectionMarkers.map(m => el('span', { class: 'chip bad', text: `注入：${m}` }))]),
            fold(k('signals'), '其他信号字段', pre(json(otherSignals))),
            el('h3', { text: '决策' }),
            kv([['动作', trace.decision?.action], ['措辞风格', trace.decision?.responseStyle]]),
            trace.decision ? scoreBars(trace.decision.scores, trace.decision.action) : null,
            el('h3', { text: '理由' }),
            el('ol', { class: 'rationale' }, (trace.decision?.rationale ?? []).map(line => el('li', { text: line }))),
        ]),
        card('③ 回忆', trace.recall ? [
            el('h3', { text: `常驻层（${trace.recall.pinned.length}）` }), memoryTable(trace.recall.pinned, '无'),
            el('h3', { text: `词法检索（${trace.recall.retrieved.length}）` }), memoryTable(trace.recall.retrieved, '无'),
            el('h3', { text: `线索召回（${trace.recall.cued.length}）` }), memoryTable(trace.recall.cued, '无'),
            kv([['模糊印象', trace.recall.fuzzy.join('、') || '—'], ['实际进入提示词', trace.recall.inPrompt.join('、') || '—']]),
        ] : el('div', { class: 'empty', text: '本轮未到达回忆阶段' })),
        card('④ 上下文与提示词', [
            trace.context ? kv([['预算', trace.context.budget], ['估算提示 tokens', trace.context.estPromptTokens],
                ['降级', trace.context.degradation], ['丢弃历史轮', trace.context.droppedHistoryTurns],
                ['丢弃记忆', trace.context.droppedMemoryIds.join('、') || '—'], ['摘要化轮次', trace.context.digestedTurns]]) : el('div', { class: 'empty', text: '无上下文规划' }),
            trace.prompt ? fold(k('system'), `系统提示词（${trace.prompt.system.length} 字）`, pre(trace.prompt.system)) : null,
            trace.prompt ? fold(k('messages'), `消息（${trace.prompt.messages.length} 条）`, el('div', {}, trace.prompt.messages.map(m =>
                el('div', { class: `msg ${m.role}` }, [el('b', { text: m.role }), pre(m.content)])))) : null,
        ]),
        ...trace.attempts.map((a, i) => card(`⑤ 模型调用 ${i + 1}${trace.attempts.length > 1 ? ` / ${trace.attempts.length}` : ''}`, [
            kv([['耗时', `${a.latencyMs} ms`], ['结束原因', a.finishReason], ['tokens', a.usage ? `提示 ${a.usage.promptTokens} · 生成 ${a.usage.completionTokens}` : '—'],
                ['原始长度', a.rawLength], ['尾部空白', trailingBlank(a.raw)], ['推理长度', a.reasoningChars], ['解析', a.parseError ? `失败：${a.parseError}` : '成功']]),
            a.reasoning ? fold(k(`reason${i}`), `模型推理（${a.reasoningChars} 字）`, pre(a.reasoning, 'thought'), true)
                : el('p', { class: 'muted', text: a.reasoningChars ? '推理内容未返回正文' : '本次调用没有推理内容（模型未开启思考或不返回）' }),
            fold(k(`raw${i}`), '原始输出', pre(a.raw, a.parseError ? 'bad' : ''), Boolean(a.parseError)),
        ], a.parseError ? '解析失败' : '')),
        card('⑥ 结构化信封', trace.envelope ? [
            el('h3', { text: '回复' }), pre(trace.envelope.reply, 'quote'),
            el('h3', { text: `状态提议（${trace.envelope.proposals.length}）` }), trace.envelope.proposals.length ? pre(json(trace.envelope.proposals)) : el('div', { class: 'empty', text: '无' }),
            el('h3', { text: `记忆写入（${trace.envelope.memoryWrites.length}）` }), trace.envelope.memoryWrites.length ? pre(json(trace.envelope.memoryWrites)) : el('div', { class: 'empty', text: '无' }),
            el('h3', { text: `世界动作（${trace.envelope.worldActions.length}）` }), trace.envelope.worldActions.length ? pre(json(trace.envelope.worldActions)) : el('div', { class: 'empty', text: '无' }),
        ] : el('div', { class: 'empty', text: trace.attempts.length ? '没有得到可解析的信封' : '本轮未调用模型' })),
        card('⑦ 结果', [
            o.fallback ? el('p', { class: 'chip bad', text: FALLBACK_LABELS[o.fallback] ?? o.fallback }) : null,
            el('h3', { text: '发出的回复' }), pre(o.reply, 'quote'),
            kv([['模型', `${o.provider} / ${o.model}`], ['总耗时', `${o.latencyMs} ms`], ['阻断原因', (o.blockedReasons ?? []).join('、') || '—'], ['错误', o.error]]),
            el('h3', { text: '状态提议结果' }),
            table([{ key: 'id', label: 'ID', class: 'mono' }, { key: 'path', label: '路径' }, { label: '结果', value: () => chips(['已应用'], 'good') },
                { label: '值', value: row => fmt(row.value) }, { key: 'reason', label: '理由' }], o.applied ?? [], '无已应用提议'),
            (o.rejected ?? []).length ? table([{ key: 'id', label: 'ID', class: 'mono' }, { key: 'path', label: '路径' },
                { label: '结果', value: row => chips([row.code], 'bad') }, { key: 'reason', label: '理由' }], o.rejected) : null,
            el('h3', { text: '记忆写入结果' }),
            table([{ key: 'title', label: '标题' }, { key: 'content', label: '内容' }, { key: 'status', label: '状态' },
                { label: '结果', value: row => chips([{ written: '已写入', held: '待审', skipped: '已跳过' }[row.result] ?? row.result],
                    row.result === 'written' ? 'good' : 'warn') }], o.memories ?? [], '本轮没有记忆写入'),
        ]),
    ]
    return el('div', { class: 'trace-detail' }, sections)
}

// Width goes through the CSSOM: the console CSP forbids inline style attributes.
function barFill(percent) {
    const node = el('span', { class: 'bar-fill' })
    node.style.width = `${percent}%`
    return node
}

function scoreBars(scores, chosen) {
    const entries = Object.entries(scores ?? {}).sort((a, b) => b[1] - a[1])
    const max = Math.max(1e-9, ...entries.map(([, v]) => Math.abs(v)))
    return el('div', { class: 'bars' }, entries.map(([name, value]) => el('div', { class: `bar ${name === chosen ? 'chosen' : ''}` }, [
        el('span', { class: 'bar-name', text: name }),
        el('span', { class: 'bar-track' }, barFill(Math.round(Math.abs(value) / max * 100))),
        el('span', { class: 'bar-value mono', text: Number(value).toFixed(2) }),
    ])))
}

/* ---------------------------------------------------------------- thinking trace */

function thoughtCard(title, draft, note) {
    return card(title, [
        kv([['听到', draft.heard], ['理解为', `${draft.meant}（置信 ${draft.meantConf}）`], ['话轮', draft.turn], ['决定', draft.decision],
            ['情绪', `${draft.emotion}${draft.intensity ? ` ×${draft.intensity}` : ''}`], ['理由', draft.reason]]),
        draft.innerOS ? el('div', {}, [el('h3', { text: '内心 OS' }), pre(draft.innerOS, 'thought')]) : null,
        draft.notes?.length ? table([{ key: 'content', label: '笔记' }, { key: 'source', label: '依据' }], draft.notes) : null,
        draft.terms?.length ? table([{ key: 'term', label: '词' }, { key: 'meaning', label: '此处含义' }, { key: 'plain', label: '字面含义' }], draft.terms) : null,
        draft.fallback ? el('p', { class: 'chip bad', text: '思考器失败，使用了兜底草稿' }) : null,
    ], note)
}

function thinkDetail(trace) {
    const t = trace.thought
    return el('div', { class: 'trace-detail' }, [
        el('ol', { class: 'flow' }, [
            el('li', { class: 'stage good' }, [el('b', { text: '输入' }), el('span', { text: `${trace.inputs.length} 条` })]),
            ...trace.steps.map(step => el('li', { class: `stage ${step.draft.fallback ? 'bad' : 'good'}` },
                [el('b', { text: `思考 ${step.chainDepth + 1}` }), el('span', { text: `${step.draft.decision} · ${step.latencyMs}ms` })])),
            el('li', { class: `stage ${t.proposed !== t.decision ? 'warn' : 'good'}` }, [el('b', { text: '裁决' }), el('span', { text: `${t.proposed} → ${t.decision}` })]),
            el('li', { class: `stage ${trace.silent ? 'skip' : 'good'}` }, [el('b', { text: '结果' }), el('span', { text: trace.silent ? '不开口' : '开口' })]),
        ]),
        card('输入', table([{ key: 'kind', label: '类型' }, { key: 'text', label: '内容' }, { key: 'ref', label: '出处', class: 'mono' }], trace.inputs)),
        ...trace.steps.map(step => thoughtCard(`思考第 ${step.chainDepth + 1} 步`, step.draft, `${step.latencyMs} ms`)),
        card('规则裁决', kv([['思考器提议', t.proposed], ['最终决定', t.decision], ['裁决理由', t.ruling], ['开口意愿', t.willingness]])),
    ])
}

/* ---------------------------------------------------------------- views */

async function viewTraces(force) {
    const query = new URLSearchParams({ limit: '100', ...(traceState.kind ? { kind: traceState.kind } : {}) })
    const data = await api(`/instances/${state.instance}/traces?${query}`)
    const signature = `${state.instance}|${traceState.kind}|${traceState.selected}|${data.traces.map(t => t.id).join(',')}`
    if (!force && signature === traceState.signature) return null
    traceState.signature = signature
    if (!data.enabled) return card('思维链', el('p', { class: 'hint', text: '本进程关闭了思维链记录（tracesPerInstance = 0）。' }))
    const traces = data.traces
    if (!traces.some(t => t.id === traceState.selected)) traceState.selected = traces[0]?.id ?? null
    const selected = traces.find(t => t.id === traceState.selected)
    const kindSelect = el('select', { 'aria-label': '类型', onchange: event => { traceState.kind = event.target.value; render() } },
        [['', '全部'], ['turn', '对话轮'], ['think', '思考环']].map(([value, label]) => el('option', { value, text: label, selected: traceState.kind === value })))
    const list = el('ul', { class: 'trace-list' }, traces.map(t => {
        const tone = t.kind === 'turn' ? turnStatus(t) : t.thought.fallback ? 'bad' : 'good'
        const head = t.kind === 'turn' ? clip(t.input, 40) : clip(t.inputs.map(i => i.text).join(' / '), 40)
        const sub = t.kind === 'turn'
            ? `${t.decision?.action ?? '—'} · ${t.outcome?.latencyMs ?? 0}ms${t.attempts.length > 1 ? ` · 重试${t.attempts.length - 1}` : ''}${t.outcome?.fallback ? ' · 兜底' : ''}`
            : `思考 · ${t.thought.decision}${t.silent ? ' · 不开口' : ''}`
        return el('li', { class: `trace-item ${tone} ${t.id === traceState.selected ? 'selected' : ''}`,
            onclick: () => { traceState.selected = t.id; render(true) } }, [
            el('div', { class: 'trace-time mono', text: `${timeOf(t.atWall)} · ${t.kind === 'turn' ? t.turnId : '思考'}` }),
            el('div', { class: 'trace-head', text: head }),
            el('div', { class: 'trace-sub', text: sub }),
        ])
    }))
    return el('div', { class: 'trace-layout' }, [
        el('aside', { class: 'card trace-side' }, [
            el('div', { class: 'toolbar' }, [el('b', { text: `思维链 · ${traces.length}` }), kindSelect]),
            el('p', { class: 'muted small', text: `只保存在本进程内存，每个实例最近 ${data.perInstance} 条，重启清空。` }),
            traces.length ? list : el('div', { class: 'empty', text: '还没有记录。发一条消息后这里会出现本轮的完整链路。' }),
        ]),
        selected ? (selected.kind === 'turn' ? turnDetail(selected) : thinkDetail(selected)) : el('div', {}),
    ])
}

async function viewConfig() {
    const [c, inst] = await Promise.all([api('/config'), api(`/instances/${state.instance}/instance-config`)])
    const profile = c.template.profile ?? {}
    const obj = value => pre(json(value))
    const entries = record => kv(Object.entries(record ?? {}).map(([key, value]) => [key, typeof value === 'object' && value !== null ? json(value) : value]))
    return el('div', { class: 'grid' }, [
        card('模型', [
            kv([['对话模型', `${c.provider.name} / ${c.provider.model}`], ['说明', c.provider.note]]),
            entries(c.provider.settings),
            el('h3', { text: '思考环模型' }),
            c.thinking ? kv([['模型', `${c.thinking.name} / ${c.thinking.model}`], ['生成上限', c.thinking.maxTokens || '不限'], ...Object.entries(c.thinking.settings).map(([key, value]) => [key, fmt(value)])])
                : el('div', { class: 'empty', text: '未配置（思考环关闭）' }),
        ], '密钥不在此显示'),
        card('对话参数', entries(c.conversation), 'ConversationConfig'),
        card('上下文预算', entries(c.contextBudget), 'ContextBudget'),
        card('运行时', [
            kv([['数据库', c.dbPath], ['默认世界', c.worldId], ['记忆审核', c.memoryReview], ['绑定码目标平台', c.bindTargetPlatform],
                ['思维链缓存', c.traces ? `每实例 ${c.traces.perInstance} 条` : '关闭'], ['世界交互', c.world ? '开启' : '关闭']]),
            c.world ? fold('cfg:world', '世界配置', obj(c.world)) : null,
            el('h3', { text: '开口意愿' }), entries(c.willingness),
            el('h3', { text: '思考环' }), entries(c.thinkingLoop),
        ]),
        card('平台适配器', Object.entries(c.adapters).flatMap(([name, value]) => [el('h3', { text: name }), entries(value)])),
        card('角色模板', [
            kv([['名字', profile.name], ['模板', `${c.template.id} v${c.template.version}`], ['内容哈希', c.template.contentHash], ['时间线事件', c.template.timelineEvents],
                ['身份', profile.occupation], ['说话风格', profile.speechStyle], ['关系备注', profile.relationshipNotes]]),
            el('h3', { text: '性格' }), chips(profile.traits ?? []),
            el('h3', { text: '目标' }), chips(profile.goals ?? []),
            el('h3', { text: '内容边界' }), chips(profile.contentBoundaries ?? [], 'warn'),
            profile.shortPersona ? el('div', {}, [el('h3', { text: '短人设' }), pre(profile.shortPersona)]) : null,
            fold('cfg:profile', '完整 profile', obj(profile)),
            fold('cfg:voice', '语音包 voice', obj(c.template.voice)),
        ]),
        card('当前实例', [
            kv([['实例', inst.record.id], ['标签', inst.record.label], ['模板', `${inst.record.templateId} v${inst.record.templateVersion}`],
                ['世界', inst.record.worldId], ['最后活跃', inst.record.lastActiveAtWall], ['记忆冲突', inst.conflicts],
                ['模板校验', inst.report.templateCheck?.status ?? fmt(inst.report.templateCheck)], ['快照来源', inst.report.snapshot?.source],
                ['重放事件', inst.report.replayedEvents]]),
            el('h3', { text: '会话' }),
            table([{ key: 0, label: '身份' }, { key: 1, label: '会话', class: 'mono' }, { label: '内存历史轮', value: row => inst.historyTurns[row[0]] ?? 0 }],
                Object.entries(inst.sessions), '本进程内还没有会话'),
            fold('cfg:rehydration', '恢复报告', obj(inst.report)),
        ]),
    ])
}
