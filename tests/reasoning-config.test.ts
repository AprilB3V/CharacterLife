import test from 'node:test'
import assert from 'node:assert/strict'
import { parseReasoningMode, reasoningBody, resolveReasoningMode } from '../src/conversation/providers/reasoning.ts'
import { deepSeekConfigFromEnv } from '../src/conversation/providers/deepseek.ts'
import { chooseProvider } from '../src/api/runtime-factory.ts'

test('verified defaults: doubao off, glm low, deepseek and unknown models send nothing', () => {
    assert.equal(resolveReasoningMode('doubao-seed-2-1-pro'), 'disabled')
    assert.equal(resolveReasoningMode('GLM-5-3-flash'), 'low')
    assert.equal(resolveReasoningMode('deepseek-v4-1-flash'), 'default')
    assert.equal(resolveReasoningMode('deepseek-chat'), 'default')
    assert.deepEqual(reasoningBody('default'), {})
})

test('an explicit mode overrides the model default; off is an alias of disabled', () => {
    assert.equal(resolveReasoningMode('doubao-seed-2-1-pro', parseReasoningMode('default')), 'default')
    assert.equal(parseReasoningMode('OFF'), 'disabled')
    assert.equal(parseReasoningMode(''), null)
    assert.equal(parseReasoningMode(undefined), null)
    assert.throws(() => parseReasoningMode('auto'), /Unknown reasoning mode/)
})

test('reasoningBody returns a fresh copy each call', () => {
    const body = reasoningBody('disabled') as { thinking: { type: string } }
    body.thinking.type = 'enabled'
    assert.deepEqual(reasoningBody('disabled'), { thinking: { type: 'disabled' } })
})

test('main provider config: model default unless CHARACTERLIFE_REASONING is set', () => {
    const env = { DEEPSEEK_API_KEY: 'test-key', DEEPSEEK_MODEL: 'doubao-seed-2-1-pro' }
    assert.equal(deepSeekConfigFromEnv(env)!.reasoning, 'disabled')
    assert.equal(deepSeekConfigFromEnv({ ...env, CHARACTERLIFE_REASONING: 'low' })!.reasoning, 'low')
    assert.equal(deepSeekConfigFromEnv({ DEEPSEEK_API_KEY: 'test-key' })!.reasoning, 'default')
})

test('chooseProvider names the reasoning mode it picked', () => {
    const saved = { ...process.env }
    try {
        process.env.DEEPSEEK_API_KEY = 'test-key'
        process.env.DEEPSEEK_MODEL = 'glm-5-3-flash'
        delete process.env.CHARACTERLIFE_REASONING
        assert.match(chooseProvider().note, /reasoning low/)
    } finally {
        for (const k of ['DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL']) {
            if (saved[k] === undefined) delete process.env[k]
            else process.env[k] = saved[k]
        }
    }
})
