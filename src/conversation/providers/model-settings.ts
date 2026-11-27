/**
 * Model connections saved from the owner console.
 *
 * - Any OpenAI-compatible endpoint works; presets only pre-fill the address and a default model.
 * - Stored as JSON next to the database (gitignored `data/`), file mode 0600. A key may be kept
 *   in the file or referenced by environment-variable name so it never touches disk.
 * - Keys never leave this module towards the console: `publicProfile()` reports only the source
 *   and the last four characters.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import type { LLMProvider } from '../../types.ts'
import { DeepSeekProvider, ProviderError, deepSeekConfigFromEnv } from './deepseek.ts'
import { REASONING_MODES, reasoningBody, resolveReasoningMode } from './reasoning.ts'
import type { ReasoningMode } from './reasoning.ts'

export interface ModelPreset {
    id: string
    label: string
    /** One-line hint shown under the preset card. */
    blurb: string
    baseUrl: string
    /** Suggested model; empty means "pick from the model list". */
    model: string
    /** Conventional environment variable for the key. */
    keyEnv: string
    /** Where to create a key. */
    keyUrl: string
    /** Local servers (Ollama, LM Studio) accept any key. */
    keyOptional?: boolean
    region: 'global' | 'cn' | 'local'
}

export const MODEL_PRESETS: readonly ModelPreset[] = [
    { id: 'deepseek', label: 'DeepSeek', blurb: '中文对话稳定，价格低', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat',
        keyEnv: 'DEEPSEEK_API_KEY', keyUrl: 'https://platform.deepseek.com/api_keys', region: 'cn' },
    { id: 'gemini', label: 'Google Gemini', blurb: 'AI Studio 免费额度，OpenAI 兼容接口', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        model: 'gemini-flash-latest', keyEnv: 'GEMINI_API_KEY', keyUrl: 'https://aistudio.google.com/apikey', region: 'global' },
    { id: 'openai', label: 'OpenAI', blurb: 'GPT 系列', baseUrl: 'https://api.openai.com/v1', model: '',
        keyEnv: 'OPENAI_API_KEY', keyUrl: 'https://platform.openai.com/api-keys', region: 'global' },
    { id: 'anthropic', label: 'Anthropic Claude', blurb: 'OpenAI 兼容层', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-5-5',
        keyEnv: 'ANTHROPIC_API_KEY', keyUrl: 'https://console.anthropic.com/settings/keys', region: 'global' },
    { id: 'ark', label: '火山方舟 · 豆包', blurb: '模型名填 Model ID 或接入点 ep-…', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3', model: '',
        keyEnv: 'ARK_API_KEY', keyUrl: 'https://console.volcengine.com/ark', region: 'cn' },
    { id: 'dashscope', label: '阿里云百炼 · 通义', blurb: 'Qwen 系列', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus',
        keyEnv: 'DASHSCOPE_API_KEY', keyUrl: 'https://bailian.console.aliyun.com/', region: 'cn' },
    { id: 'moonshot', label: 'Moonshot · Kimi', blurb: '长上下文', baseUrl: 'https://api.moonshot.cn/v1', model: '',
        keyEnv: 'MOONSHOT_API_KEY', keyUrl: 'https://platform.moonshot.cn/console/api-keys', region: 'cn' },
    { id: 'zhipu', label: '智谱 · GLM', blurb: 'GLM 系列', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: '',
        keyEnv: 'ZHIPUAI_API_KEY', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys', region: 'cn' },
    { id: 'siliconflow', label: '硅基流动', blurb: '多家开源模型聚合', baseUrl: 'https://api.siliconflow.cn/v1', model: '',
        keyEnv: 'SILICONFLOW_API_KEY', keyUrl: 'https://cloud.siliconflow.cn/account/ak', region: 'cn' },
    { id: 'openrouter', label: 'OpenRouter', blurb: '一个 Key 用多家模型', baseUrl: 'https://openrouter.ai/api/v1', model: '',
        keyEnv: 'OPENROUTER_API_KEY', keyUrl: 'https://openrouter.ai/keys', region: 'global' },
    { id: 'ollama', label: 'Ollama（本机）', blurb: '离线运行，无需 Key', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b',
        keyEnv: '', keyUrl: 'https://ollama.com/download', keyOptional: true, region: 'local' },
    { id: 'custom', label: '自定义', blurb: '任何 OpenAI 兼容接口', baseUrl: '', model: '', keyEnv: '', keyUrl: '', region: 'global' },
]

export interface ModelProfile {
    id: string
    label: string
    preset: string
    baseUrl: string
    model: string
    /** Key kept in the settings file. */
    apiKey?: string
    /** Or: read the key from this environment variable at use time. */
    apiKeyEnv?: string
    /** null/absent: the verified default for the model (see reasoning.ts). */
    reasoning?: ReasoningMode | null
    timeoutMs?: number
    updatedAt: string
}

export interface ModelSettings {
    version: 1
    /** Profile in use; null means "environment variables / built-in default". */
    active: string | null
    profiles: ModelProfile[]
}

export interface PublicModelProfile extends Omit<ModelProfile, 'apiKey'> {
    keySource: 'stored' | 'env' | 'missing' | 'not-needed'
    keyHint: string | null
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

export class ModelSettingsError extends Error {
    readonly code: string
    constructor(code: string, message: string) {
        super(message)
        this.code = code
    }
}

/** Settings path: CHARACTERLIFE_MODEL_SETTINGS, else beside a file database; null for in-memory databases. */
export function modelSettingsPathFor(dbPath: string, env: NodeJS.ProcessEnv = process.env): string | null {
    const explicit = env.CHARACTERLIFE_MODEL_SETTINGS?.trim()
    if (explicit) return resolve(explicit)
    if (!dbPath || dbPath === ':memory:' || dbPath.startsWith('file:')) return null
    return join(dirname(resolve(dbPath)), 'model-settings.json')
}

export function emptyModelSettings(): ModelSettings {
    return { version: 1, active: null, profiles: [] }
}

export function readModelSettings(path: string | null): ModelSettings {
    if (!path || !existsSync(path)) return emptyModelSettings()
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
    if (!raw || typeof raw !== 'object' || !Array.isArray((raw as ModelSettings).profiles)) {
        throw new ModelSettingsError('INVALID_SETTINGS', `模型配置文件结构无效：${path}`)
    }
    const value = raw as ModelSettings
    const profiles = value.profiles.filter(item => item && typeof item.id === 'string' && typeof item.baseUrl === 'string')
    const active = profiles.some(item => item.id === value.active) ? value.active : null
    return { version: 1, active, profiles }
}

/** Atomic write (temp file + rename), owner-only permissions where the platform has them. */
export function writeModelSettings(path: string, settings: ModelSettings): void {
    mkdirSync(dirname(path), { recursive: true })
    const temp = `${path}.${randomBytes(4).toString('hex')}.tmp`
    try {
        writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 })
        renameSync(temp, path)
        try { chmodSync(path, 0o600) } catch { /* not supported on every filesystem */ }
    } finally {
        rmSync(temp, { force: true })
    }
}

export function presetById(id: string | undefined): ModelPreset | undefined {
    return MODEL_PRESETS.find(item => item.id === id)
}

/** HTTPS anywhere, plain HTTP only on loopback; no credentials, query or fragment in the URL. */
export function normalizeBaseUrl(raw: unknown): string {
    if (typeof raw !== 'string' || !raw.trim()) throw new ModelSettingsError('INVALID_BASE_URL', '请填写 API 地址')
    let url: URL
    try { url = new URL(raw.trim()) } catch { throw new ModelSettingsError('INVALID_BASE_URL', 'API 地址格式不对，例如 https://api.example.com/v1') }
    const loopback = LOOPBACK.has(url.hostname)
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
        throw new ModelSettingsError('INVALID_BASE_URL', '只接受 HTTPS 地址；HTTP 仅限本机（127.0.0.1 / localhost）')
    }
    if (url.username || url.password || url.search || url.hash) {
        throw new ModelSettingsError('INVALID_BASE_URL', 'API 地址里不能带账号、查询参数或 #')
    }
    // Users often paste the full endpoint; the provider appends /chat/completions itself.
    return url.toString().replace(/\/+$/, '').replace(/\/chat\/completions$/, '')
}

const sameOrigin = (a: string | undefined, b: string): boolean => {
    try { return Boolean(a) && new URL(a!).origin === new URL(b).origin } catch { return false }
}

function envKey(name: string | undefined, env: NodeJS.ProcessEnv): string {
    return name && ENV_NAME.test(name) ? env[name]?.trim() ?? '' : ''
}

/** Key in effect for a profile, or '' when none is available. */
export function resolveProfileKey(profile: Pick<ModelProfile, 'apiKey' | 'apiKeyEnv' | 'preset'>, env: NodeJS.ProcessEnv = process.env): string {
    if (profile.apiKey?.trim()) return profile.apiKey.trim()
    const fromEnv = envKey(profile.apiKeyEnv, env)
    if (fromEnv) return fromEnv
    return presetById(profile.preset)?.keyOptional ? 'local-no-key' : ''
}

export function publicProfile(profile: ModelProfile, env: NodeJS.ProcessEnv = process.env): PublicModelProfile {
    const { apiKey, ...rest } = profile
    const stored = apiKey?.trim() ?? ''
    const fromEnv = envKey(profile.apiKeyEnv, env)
    const keySource = stored ? 'stored' : fromEnv ? 'env' : presetById(profile.preset)?.keyOptional ? 'not-needed' : 'missing'
    const key = stored || fromEnv
    return { ...rest, keySource, keyHint: key ? `••••${key.slice(-4)}` : null }
}

export function providerFromProfile(profile: ModelProfile, env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): DeepSeekProvider {
    const apiKey = resolveProfileKey(profile, env)
    if (!apiKey) {
        throw new ModelSettingsError('MISSING_KEY', profile.apiKeyEnv
            ? `环境变量 ${profile.apiKeyEnv} 没有设置，配置「${profile.label}」缺少 API Key`
            : `配置「${profile.label}」缺少 API Key`)
    }
    const mode = resolveReasoningMode(profile.model, profile.reasoning ?? null)
    return new DeepSeekProvider({ apiKey, baseUrl: profile.baseUrl, model: profile.model, timeoutMs: profile.timeoutMs,
        extraBody: reasoningBody(mode), ...(fetchImpl ? { fetchImpl } : {}) })
}

/** Draft from the console form, before it becomes a stored profile. */
export interface ModelDraft {
    id?: string
    label?: string
    preset?: string
    baseUrl?: string
    model?: string
    apiKey?: string
    apiKeyEnv?: string
    reasoning?: string | null
    timeoutMs?: number
}

export function parseDraft(body: Record<string, unknown>): ModelDraft {
    const str = (key: string, max = 512): string | undefined => {
        const value = body[key]
        if (value === undefined || value === null) return undefined
        if (typeof value !== 'string') throw new ModelSettingsError('INVALID_FIELD', `${key} 必须是字符串`)
        if (value.length > max) throw new ModelSettingsError('INVALID_FIELD', `${key} 过长`)
        return value.trim()
    }
    const timeout = body.timeoutMs
    if (timeout !== undefined && timeout !== null && (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 3000 || timeout > 600_000)) {
        throw new ModelSettingsError('INVALID_FIELD', '超时需为 3000–600000 毫秒的整数')
    }
    const reasoning = str('reasoning', 16)
    if (reasoning && !(REASONING_MODES as readonly string[]).includes(reasoning)) {
        throw new ModelSettingsError('INVALID_FIELD', `推理强度只能是 ${REASONING_MODES.join(' / ')}`)
    }
    const apiKeyEnv = str('apiKeyEnv', 64)
    if (apiKeyEnv && !ENV_NAME.test(apiKeyEnv)) throw new ModelSettingsError('INVALID_FIELD', '环境变量名只能含字母、数字和下划线')
    return { id: str('id', 64), label: str('label', 60), preset: str('preset', 32), baseUrl: str('baseUrl'), model: str('model', 200),
        apiKey: str('apiKey', 1024), apiKeyEnv, reasoning: reasoning || null, ...(typeof timeout === 'number' ? { timeoutMs: timeout } : {}) }
}

/**
 * Where the key for a draft comes from, in order: typed in the form; the edited profile's stored
 * key (same origin only, so a key is never sent to a different vendor); the named environment
 * variable; the process's own model environment (same origin); none needed for local servers.
 */
export function resolveDraftKey(draft: ModelDraft, settings: ModelSettings, baseUrl: string, env: NodeJS.ProcessEnv = process.env):
    { key: string; store: Pick<ModelProfile, 'apiKey' | 'apiKeyEnv'> } {
    if (draft.apiKey) return { key: draft.apiKey, store: { apiKey: draft.apiKey } }
    const existing = settings.profiles.find(item => item.id === draft.id)
    if (existing?.apiKey && sameOrigin(existing.baseUrl, baseUrl)) return { key: existing.apiKey, store: { apiKey: existing.apiKey } }
    const named = draft.apiKeyEnv ?? (existing && sameOrigin(existing.baseUrl, baseUrl) ? existing.apiKeyEnv : undefined)
    if (named && envKey(named, env)) return { key: envKey(named, env), store: { apiKeyEnv: named } }
    const preset = presetById(draft.preset)
    if (!named && preset?.keyEnv && envKey(preset.keyEnv, env)) return { key: envKey(preset.keyEnv, env), store: { apiKeyEnv: preset.keyEnv } }
    try {
        const fromEnv = deepSeekConfigFromEnv(env)
        if (fromEnv && sameOrigin(fromEnv.baseUrl, baseUrl)) {
            const name = env.CHARACTERLIFE_MODEL_BASE_URL ? 'CHARACTERLIFE_MODEL_API_KEY' : 'DEEPSEEK_API_KEY'
            return { key: fromEnv.apiKey, store: { apiKeyEnv: name } }
        }
    } catch { /* incomplete environment config: ignore */ }
    if (preset?.keyOptional) return { key: 'local-no-key', store: {} }
    if (named) throw new ModelSettingsError('MISSING_KEY', `环境变量 ${named} 没有设置`)
    throw new ModelSettingsError('MISSING_KEY', '请填写 API Key')
}

/** A profile ready to store, from a draft; validates every field. */
export function profileFromDraft(draft: ModelDraft, settings: ModelSettings, env: NodeJS.ProcessEnv = process.env, now = new Date()): ModelProfile {
    const baseUrl = normalizeBaseUrl(draft.baseUrl)
    if (!draft.model) throw new ModelSettingsError('INVALID_FIELD', '请填写模型名称（可点「获取模型列表」选择）')
    const preset = presetById(draft.preset) ?? presetById('custom')!
    const { store } = resolveDraftKey(draft, settings, baseUrl, env)
    const id = draft.id && settings.profiles.some(item => item.id === draft.id) ? draft.id : `m_${randomBytes(4).toString('hex')}`
    return { id, label: draft.label || `${preset.label} · ${draft.model}`, preset: preset.id, baseUrl, model: draft.model, ...store,
        reasoning: (draft.reasoning as ReasoningMode | null) ?? null, ...(draft.timeoutMs ? { timeoutMs: draft.timeoutMs } : {}), updatedAt: now.toISOString() }
}

/** One tiny completion against a draft; resolves with the reply or a readable error. */
export async function probeModel(provider: LLMProvider): Promise<{ ok: true; latencyMs: number; reply: string; model: string }> {
    const started = Date.now()
    const response = await provider.complete({ system: 'Reply with one short word.', messages: [{ role: 'user', content: 'ping' }],
        temperature: 0, maxTokens: 0, jsonMode: false })
    return { ok: true, latencyMs: Date.now() - started, reply: response.text.trim().slice(0, 120), model: response.model || provider.model }
}

/** GET {baseUrl}/models — supported by most OpenAI-compatible vendors. */
export async function listRemoteModels(baseUrl: string, key: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12_000)
    try {
        const response = await fetchImpl(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal })
        const text = await response.text()
        if (!response.ok) throw new ProviderError(`获取模型列表失败（HTTP ${response.status}）：${text.slice(0, 200)}`, response.status)
        const data = JSON.parse(text) as { data?: Array<{ id?: unknown }>; models?: Array<{ name?: unknown; id?: unknown }> }
        const ids = [...(data.data ?? []).map(item => item.id), ...(data.models ?? []).map(item => item.id ?? item.name)]
        return [...new Set(ids.filter((id): id is string => typeof id === 'string').map(id => id.replace(/^models\//, '')))].sort()
    } catch (error) {
        if ((error as Error).name === 'AbortError') throw new ProviderError('获取模型列表超时（12 秒）')
        throw error
    } finally {
        clearTimeout(timer)
    }
}
