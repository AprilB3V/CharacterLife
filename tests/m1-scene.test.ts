import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { RuleMind } from '../src/kernel/cycle/mind.ts'
import { WorldBridge } from '../src/kernel/cycle/bridge.ts'
import { HOUR } from '../src/kernel/util/clock.ts'
import { SequentialIdFactory } from '../src/kernel/util/ids.ts'
import type { LLMProvider, LLMRequest } from '../src/types.ts'
import { SANDBOX_INSTANCE_ID, SHEN_RULE_MIND } from '../experiments/sandbox/scenario.ts'
import { Scene } from '../experiments/m1/scene.ts'
import { M1_SCRIPT } from '../experiments/m1/script.ts'

// M1 stage 1 (2026-11-20): one character in town life and chat, rebuilt from disk in between.

const ROOT = join(process.cwd(), 'tests', '.data', 'm1')
let counter = 0
function dir(): string {
    const d = join(ROOT, `case_${++counter}_${Date.now().toString(36)}`)
    mkdirSync(d, { recursive: true })
    return d
}
after(() => rmSync(ROOT, { recursive: true, force: true }))

/** Chat model stand-in: answers from a queue of envelopes and records every request. */
function scripted(replies: object[]): { provider: LLMProvider; requests: LLMRequest[] } {
    const requests: LLMRequest[] = []
    let i = 0
    const provider: LLMProvider = {
        name: 'scripted',
        model: 'scripted',
        async complete(request: LLMRequest) {
            requests.push(request)
            const body = replies[Math.min(i++, replies.length - 1)]
            return { text: JSON.stringify(body), provider: 'scripted', model: 'scripted', usage: null, latencyMs: 0, finishReason: 'stop' }
        },
    }
    return { provider, requests }
}

const plain = (reply: string, extra: object = {}) => ({ reply, proposals: [], memoryWrites: [], ...extra })

function scene(provider: LLMProvider): Scene {
    return new Scene({ dir: dir(), seed: 1, makeMind: () => new RuleMind(SHEN_RULE_MIND), provider })
}

test('the script never tells the character which action to take', () => {
    const steps = M1_SCRIPT.filter((s) => s.kind === 'say')
    assert.ok(steps.some((s) => s.check === 'act_request'))
    assert.equal(M1_SCRIPT.filter((s) => s.kind === 'reopen').length, 1)
    // Only time, world and user lines: no step type carries a character action.
    assert.deepEqual([...new Set(M1_SCRIPT.map((s) => s.kind))].sort(), ['live', 'reopen', 'say'])
})

test('rebuilt from disk: memories and drives come back, world events are not written twice', async () => {
    const sc = scene(scripted([plain('嗯。')]).provider)
    await sc.live(3)
    const before = sc.character.workspace.memory.list()
    const drives = sc.character.workspace.dynamicState.drives
    assert.ok(before.length > 0, 'town life wrote memories')
    sc.reopen()
    assert.equal(sc.character.generation, 1)
    assert.deepEqual(sc.character.workspace.memory.list().map((m) => m.id), before.map((m) => m.id))
    assert.deepEqual(sc.character.workspace.dynamicState.drives, drives, 'restart does not reset drives')
    sc.passTime(30 * 60_000)
    await sc.live(1)
    const refs = sc.character.workspace.memory.list().map((m) => m.sourceRef).filter(Boolean)
    assert.equal(refs.length, new Set(refs).size, 'no world event written twice')
    assert.ok(sc.character.workspace.situation.current().location, 'situation re-perceived after the rebuild')
})

test('without a checkpoint a rebuilt bridge would write old world events again', async () => {
    const sc = scene(scripted([plain('嗯。')]).provider)
    await sc.live(3)
    const ws = sc.character.workspace
    const n = ws.memory.list().length
    const fresh = new WorldBridge({ agent: ws, world: sc.world, instanceId: SANDBOX_INSTANCE_ID, ids: new SequentialIdFactory() })
    fresh.sync()
    assert.ok(ws.memory.list().length > n, 'the gap the checkpoint closes')
    const resumed = new WorldBridge({
        agent: ws, world: sc.world, instanceId: SANDBOX_INSTANCE_ID, ids: new SequentialIdFactory(), resumeFrom: fresh.checkpoint(),
    })
    const m = ws.memory.list().length
    resumed.sync()
    assert.equal(ws.memory.list().length, m)
})

test('a chat action is only a proposal until the world settles it; then it is a confirmed fact', async () => {
    const { provider, requests } = scripted([
        plain('好，我过去看看。', { worldActions: [{ verb: 'move_to', target: 'plaza', reason: '用户想知道摊位开没开', expectation: '走到广场' }] }),
        plain('还在路上。'),
        plain('到了。'),
    ])
    const sc = scene(provider)
    sc.clock.setSim(13 * HOUR)
    const first = await sc.say('你能去广场看一眼吗？')
    assert.equal(first.worldActions?.admitted.length, 1)
    const id = first.worldActions!.admitted[0]!.actionId
    assert.notEqual(sc.world.list({ instanceId: SANDBOX_INSTANCE_ID }).find((a) => a.actionId === id)!.status, 'succeeded')

    await sc.say('到了吗？')
    assert.equal(sc.character.binding.context!.confirmed.length, 0, 'not settled: nothing confirmed')
    assert.equal(sc.character.binding.context!.unconfirmed.length, 1)

    sc.settle()
    assert.equal(sc.world.list({ instanceId: SANDBOX_INSTANCE_ID }).find((a) => a.actionId === id)!.status, 'succeeded')
    assert.equal(sc.town.location, 'plaza')
    await sc.say('现在呢？')
    assert.equal(sc.character.binding.context!.confirmed.length, 1)
    const world = sc.character.workspace.memory.list().filter((m) => m.origin === 'runtime_event' && m.sourceRef)
    assert.ok(world.some((m) => m.title.includes('去广场')), 'the settled result became a world memory')
    assert.equal(requests.length, 3)
})

test('a user fact told in chat survives the rebuild and reaches the next chat prompt', async () => {
    const { provider, requests } = scripted([
        plain('记住了，小满。', { memoryWrites: [{ kind: 'user', title: '用户的名字', content: '用户叫小满，下周四去出版社面试。', status: 'fact', salience: 0.8, cues: ['小满', '面试'] }] }),
        plain('你叫小满。'),
    ])
    const sc = scene(provider)
    sc.clock.setSim(13 * HOUR)
    await sc.say('我叫小满，下周四去面试。')
    sc.reopen()
    await sc.say('还记得我下周要去面试吗？')
    const second = [requests[1]!.system, ...requests[1]!.messages.map((m) => m.content)].join('\n')
    assert.ok(second.includes('用户叫小满'), 'restored memory is in the new prompt')
    assert.equal(requests[1]!.messages.filter((m) => m.role === 'assistant').length, 0, 'no chat history crossed the rebuild')
})
