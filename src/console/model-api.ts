/**
 * Console "模型接入": list presets and saved connections, test a draft, fetch a vendor's model
 * list, save / activate / delete connections. Activation swaps the live chat model in place.
 *
 * Keys flow one way: from the form or the environment into the settings file and the provider.
 * Nothing here returns a key; profiles go out through publicProfile().
 */

import type { RuntimeBundle } from '../api/runtime-factory.ts'
import { chooseProvider } from '../api/runtime-factory.ts'
import { MockProvider } from '../conversation/providers/mock.ts'
import { DeepSeekProvider } from '../conversation/providers/deepseek.ts'
import { reasoningBody, resolveReasoningMode } from '../conversation/providers/reasoning.ts'
import type { ReasoningMode } from '../conversation/providers/reasoning.ts'
import {
    MODEL_PRESETS, ModelSettingsError, listRemoteModels, normalizeBaseUrl, parseDraft, probeModel, profileFromDraft,
    providerFromProfile, publicProfile, readModelSettings, resolveDraftKey, writeModelSettings,
} from '../conversation/providers/model-settings.ts'
import type { ModelSettings } from '../conversation/providers/model-settings.ts'

const PROBE_TIMEOUT_MS = 30_000

export interface ModelApiOptions {
    env?: NodeJS.ProcessEnv
    /** Test seam for the network. */
    fetchImpl?: typeof fetch
}

export function createModelApi(runtime: RuntimeBundle, opts: ModelApiOptions = {}) {
    const env = opts.env ?? process.env
    const path = runtime.modelSettingsPath
    const model = runtime.chatModel

    const load = (): ModelSettings => readModelSettings(path)
    const save = (settings: ModelSettings) => {
        if (!path) throw new ModelSettingsError('READ_ONLY', '当前数据库在内存中，无法保存模型配置（可设置 CHARACTERLIFE_MODEL_SETTINGS）')
        writeModelSettings(path, settings)
    }

    const current = () => ({ name: model.name, model: model.model, note: model.note, source: model.source,
        mock: model.inner instanceof MockProvider, settings: runtime.describe().provider.settings })

    const activate = (settings: ModelSettings, id: string | null) => {
        if (id === null) {
            const fallback = chooseProvider()
            model.swap(fallback.provider, fallback.note, fallback.provider instanceof MockProvider ? 'mock' : 'env')
            return
        }
        const profile = settings.profiles.find(item => item.id === id)
        if (!profile) throw new ModelSettingsError('NOT_FOUND', '配置不存在')
        model.swap(providerFromProfile(profile, env, opts.fetchImpl), `后台配置「${profile.label}」`, `console:${profile.id}`)
    }

    return {
        describe() {
            const settings = load()
            return { current: current(), presets: MODEL_PRESETS, writable: path !== null, path,
                active: settings.active, profiles: settings.profiles.map(item => publicProfile(item, env)),
                // A swap is impossible while an explicit provider was injected by code (tests, demos).
                locked: model.source === 'explicit' }
        },

        async test(body: Record<string, unknown>) {
            const draft = parseDraft(body)
            const baseUrl = normalizeBaseUrl(draft.baseUrl)
            if (!draft.model) throw new ModelSettingsError('INVALID_FIELD', '请先填写模型名称')
            const { key } = resolveDraftKey(draft, load(), baseUrl, env)
            const mode = resolveReasoningMode(draft.model, (draft.reasoning as ReasoningMode | null) ?? null)
            const provider = new DeepSeekProvider({ apiKey: key, baseUrl, model: draft.model, timeoutMs: Math.min(draft.timeoutMs ?? PROBE_TIMEOUT_MS, PROBE_TIMEOUT_MS),
                extraBody: reasoningBody(mode), ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) })
            return probeModel(provider)
        },

        async models(body: Record<string, unknown>) {
            const draft = parseDraft(body)
            const baseUrl = normalizeBaseUrl(draft.baseUrl)
            const { key } = resolveDraftKey(draft, load(), baseUrl, env)
            return { models: await listRemoteModels(baseUrl, key, opts.fetchImpl) }
        },

        save(body: Record<string, unknown>) {
            if (model.source === 'explicit') throw new ModelSettingsError('LOCKED', '本进程的模型由代码注入，后台不能切换')
            const settings = load()
            const profile = profileFromDraft(parseDraft(body), settings, env)
            const profiles = settings.profiles.some(item => item.id === profile.id)
                ? settings.profiles.map(item => item.id === profile.id ? profile : item)
                : [...settings.profiles, profile]
            const next: ModelSettings = { ...settings, profiles }
            const shouldActivate = body.activate === true || settings.active === profile.id
            // Build the provider before writing, so a broken profile never becomes active on disk.
            if (shouldActivate) {
                activate(next, profile.id)
                next.active = profile.id
            }
            save(next)
            return { id: profile.id, activated: shouldActivate, message: shouldActivate ? `已保存并切换到「${profile.label}」，下一句对话起生效` : `已保存「${profile.label}」` }
        },

        use(id: string | null) {
            if (model.source === 'explicit') throw new ModelSettingsError('LOCKED', '本进程的模型由代码注入，后台不能切换')
            const settings = load()
            activate(settings, id)
            save({ ...settings, active: id })
            return { message: id === null ? `已改用环境变量配置：${model.note}` : `已切换到 ${model.model}，下一句对话起生效` }
        },

        remove(id: string) {
            const settings = load()
            const profile = settings.profiles.find(item => item.id === id)
            if (!profile) throw new ModelSettingsError('NOT_FOUND', '配置不存在')
            const next: ModelSettings = { ...settings, profiles: settings.profiles.filter(item => item.id !== id) }
            if (settings.active === id) {
                activate(next, null)
                next.active = null
            }
            save(next)
            return { message: `已删除「${profile.label}」${settings.active === id ? `，已回到 ${model.note}` : ''}` }
        },
    }
}

export type ModelApi = ReturnType<typeof createModelApi>
