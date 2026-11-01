import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { JingjingKnowledge } from '../examples/video-cohost/knowledge.ts'
import { assembleRuntime } from '../src/api/runtime-factory.ts'
import { SpyProvider } from './helpers.ts'
import { MockProvider } from '../src/conversation/providers/mock.ts'
import { JingjingGameAdapter } from '../examples/video-cohost/game-adapter.ts'

const knowledgePath = resolve(import.meta.dirname, '../../jingjing-overlay/knowledge/Probably-Stolen-鲸鲸知识库-v2.md')

test('knowledge keeps premise resident, retrieves aliases, and excludes state examples and unseen stories', () => {
    const knowledge = new JingjingKnowledge(knowledgePath)
    const ordinary = knowledge.render('你好')
    assert.match(knowledge.worldContext(), /收银终端/)
    assert.match(ordinary, /未经游戏内验证|未在游戏内验证/)
    assert.ok(!ordinary.includes('初始 500'))
    assert.ok(!ordinary.includes('资金：-1200'))
    assert.ok(!ordinary.includes('清除证据、evidence_removal'))
    const query = knowledge.render('EVIDENCE_REMOVAL 是什么？')
    assert.match(query, /初始 500/)
    assert.match(query, /冷却 14 天/)
    assert.ok(!knowledge.render('cartel').includes('涉及特殊来客和交易的组织'))
})

test('a hand-written seen-list cannot unlock story knowledge', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jingjing-knowledge-'))
    try {
        const path = join(directory, 'knowledge.md')
        const source = readFileSync(knowledgePath, 'utf8')
        writeFileSync(path, source)
        const knowledge = new JingjingKnowledge(path)
        assert.ok(!knowledge.render('cartel').includes('涉及特殊来客和交易的组织'))
        writeFileSync(path, source.replace('- （空）', '- 已见过：卡特尔首次来客'))
        assert.ok(!knowledge.render('cartel').includes('涉及特殊来客和交易的组织'))
    } finally {
        rmSync(directory, { recursive: true, force: true })
    }
})

test('CL injects references each turn without putting them in system, chat history or automatic memories', async () => {
    const provider = new SpyProvider(new MockProvider({ mode: 'in-character' }))
    const knowledge = new JingjingKnowledge(knowledgePath)
    const runtime = assembleRuntime({ dbPath: ':memory:', worldId: 'world_jingjing_video', provider,
        world: { enabled: true, worldIds: ['world_jingjing_video'], acceptObservations: true, allowedVerbs: [], allowedTargets: [] },
        configureInstance: (instance, context) => new JingjingGameAdapter({ instance, ...context, knowledge }) })
    try {
        const identity = runtime.identityService.resolveOrCreate('sillytavern', 'jingjing-knowledge-test', '鲸鲸测试')
        const instanceId = identity.instance.id
        const instance = runtime.runtimeManager.get(instanceId)
        await runtime.runtimeManager.send(instance, { identityKey: 'sillytavern:jingjing-knowledge-test', text: '清除证据是什么？' })
        const data = provider.lastRequest!.messages.map(message => message.content).join('\n')
        assert.match(data, /初始 500/)
        assert.match(data, /收银终端/)
        assert.ok(!provider.lastRequest!.system.includes('初始 500'))
        const history = instance.histories.get('sillytavern:jingjing-knowledge-test')!
        assert.equal(history[0]!.content, '清除证据是什么？')
        assert.equal(runtime.persistence.listMemories(instanceId).length, 0)
        await runtime.runtimeManager.send(instance, { identityKey: 'sillytavern:jingjing-knowledge-test', text: '你好' })
        const next = provider.lastRequest!.messages.at(-1)!.content
        assert.match(next, /收银终端/)
        assert.ok(!next.includes('初始 500'))
    } finally {
        runtime.close()
    }
})
