import test from 'node:test'
import assert from 'node:assert/strict'
import { assembleRuntime } from '../src/api/runtime-factory.ts'
import { isAbsenceClaim } from '../src/conversation/meta-memory.ts'
import type { LLMProvider } from '../src/types.ts'

// Taken from M0 baseline runs (2026-11-17/18); each one concerned a fact that was already stored.
const ABSENCE = [
    ['用户养了一只猫，名字未知', '此前记忆中没有这条信息，名字尚未得知。'],
    ['问起猫的名字', '用户问我记不记得她猫的名字；我此前没有收到过关于猫的信息。'],
    ['用户问猫的名字，沈知微承认未记录', '她没有记录任何宠物信息，因此无法回答。'],
    ['用户两次提到养宠物但说法不一致', '沈知微此前无任何宠物记录，两次说法不一致。'],
    ['宠物说法不一致', '两次都未给出具体宠物信息，无法确认其是否养宠物。'],
    ['用测试和无关内容试我', '问一个我从没听过的猫的名字，像是在试我。'],
    ['今天聊得不太顺的两处记岔', '周会倾诉被记成约定，猫的名字凭空问起。'],
    ['用户提到自己有猫', '用户问我他的猫叫什么，说明他有一只猫；此前从未向我提过名字。'],
]

// Ordinary memories from the same runs, including ones that talk about remembering.
const ORDINARY = [
    ['用户养了一只橘猫叫栗子', '用户提到自己养了一只橘猫，名字叫栗子。'],
    ['确认会记得科目二的约定', '沈知微说便签压在桌角镇纸底下，翻的时候就看见。'],
    ['考试日期出现分歧', '用户说她记得科目二在下周五，而我便签上记的是下周三。尚未确认哪个为准。'],
    ['用户发了省略号，沈知微没有追问', '用户发来一串省略号，没有说明情绪。'],
    ['用户称先前的要求只是玩笑', '我表明玩笑接得住，但便签上的约定仍算数。'],
    ['一次评价请求', '她指出缺少内层循环，未代改。'],
    // Facts about the user that contain a negation (Codex review 2026-11-18).
    ['用户不熟悉爵士', '用户从没听过爵士乐。'],
    ['医生预约', '用户没记住医生预约时间，回头要查短信。'],
    ['用户说她从没听过爵士乐', '想找几张入门唱片。'],
    ['写小说', '用户凭空想出一个故事开头。'],
]

test('absence claims from the baseline are detected', () => {
    for (const [title, content] of ABSENCE) assert.ok(isAbsenceClaim(title!, content!), title)
})

test('ordinary memories are not flagged', () => {
    for (const [title, content] of ORDINARY) assert.ok(!isAbsenceClaim(title!, content!), title)
})

test('a meta-memory write is skipped and audited, the real fact is kept', async () => {
    const reply = JSON.stringify({
        reply: '栗子。',
        proposals: [],
        memoryWrites: [
            { kind: 'user', title: '用户养了一只橘猫叫栗子', content: '橘猫，名字叫栗子。', status: 'fact', salience: 0.5 },
            { kind: 'user', title: '问起猫的名字', content: '我此前没有收到过关于猫的信息。', status: 'fact', salience: 0.5 },
        ],
    })
    const provider: LLMProvider = {
        name: 'fixed',
        model: 'fixed',
        async complete() {
            return { text: reply, provider: 'fixed', model: 'fixed', usage: null, latencyMs: 0, finishReason: 'stop' }
        },
    }
    const runtime = assembleRuntime({ dbPath: ':memory:', worldId: 'world_test', provider })
    try {
        const identity = runtime.identityService.resolveOrCreate('sillytavern', 'user', '用户')
        const instance = runtime.runtimeManager.get(identity.instance.id)
        await runtime.runtimeManager.send(instance, { identityKey: 'user', text: '我的猫叫什么' })
        const titles = instance.workspace.memory.list().map((m) => m.title)
        assert.ok(titles.includes('用户养了一只橘猫叫栗子'))
        assert.ok(!titles.includes('问起猫的名字'))
        const skipped = instance.workspace.audit.filter('memory_skipped')
        assert.equal(skipped.length, 1)
        assert.equal(skipped[0]!.data.title, '问起猫的名字')
    } finally { runtime.close() }
})
