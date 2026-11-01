/**
 * Offline console demo: in-memory database, scripted model, simulated reader events.
 * Touches no real data and makes no model calls.
 *
 *   node examples/video-cohost/console-demo.ts
 */
import { resolve } from 'node:path'
import { assembleRuntime } from '../../src/api/runtime-factory.ts'
import { createConsoleServer } from '../../src/console/server.ts'
import { ManualClock } from '../../src/kernel/util/clock.ts'
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/types.ts'
import { jingjingTemplate } from '../characters/jingjing.ts'
import { JingjingKnowledge } from './knowledge.ts'
import { JingjingGameAdapter } from './game-adapter.ts'

const WORLD = 'world_jingjing_video'
const RUN = '1:demo-run'
const DEMO_TOKEN = 'demo-console-token-not-secret'

class DemoProvider implements LLMProvider {
    readonly name = 'demo'
    readonly model = 'demo-scripted'
    async complete(request: LLMRequest): Promise<LLMResponse> {
        const last = String(request.meta?.userText ?? '').slice(0, 40)
        const text = JSON.stringify({ reply: '行吧，记账了。', proposals: [], memoryWrites: [
            { kind: 'user', title: '主播说过的话', content: `用户说：${last}`, status: 'fact', salience: 0.4, tags: ['demo'] }] })
        return { text, provider: this.name, model: this.model, usage: null, latencyMs: 0, finishReason: 'stop' }
    }
}

const clock = new ManualClock(Date.now())
const knowledge = new JingjingKnowledge(resolve(import.meta.dirname, '../../tests/season/fixtures/knowledge.md'))
const runtime = assembleRuntime({ dbPath: ':memory:', worldId: WORLD, template: jingjingTemplate, clock, provider: new DemoProvider(), memoryReview: 'model',
    world: { enabled: true, worldIds: [WORLD], acceptObservations: true, allowedVerbs: [], allowedTargets: [] },
    configureInstance: (instance, context) => new JingjingGameAdapter({ instance, ...context, knowledge, worldReview: 'review' }),
})
const instance = runtime.runtimeManager.get(runtime.identityService.resolveOrCreate('sillytavern', 'streamer', '主播').instance.id)

async function observe(eventId: string, facts: Array<{ key: string; value: string | number | boolean }>, summary: string): Promise<void> {
    clock.advance(1000)
    runtime.world!.ingest(WORLD, [{ eventId, instanceId: instance.instanceId, kind: 'observation', actionId: null, result: null,
        atWorldTimeMs: clock.nowSim(), summary, facts: [{ key: 'source', value: 'probably-stolen' }, ...facts] }])
    await runtime.runtimeManager.syncWorld(instance.instanceId)
}
const snapshot = (id: string, day: number, cash: number, investigation: number) => observe(id, [{ key: 'snapshotId', value: id }, { key: 'page', value: 0 },
    { key: 'pages', value: 1 }, { key: 'ready', value: true }, { key: 'capturedAt', value: clock.nowSim() + 1000 }, { key: 'cash', value: cash },
    { key: 'save', value: RUN }, { key: 'rent', value: 500 }, { key: 'day', value: day }, { key: 'investigation', value: investigation },
    { key: 'item.0', value: JSON.stringify(['dream_dust', '梦尘', 'store', 3]) }], '读取器快照')
const event = (id: string, tag: string, summary: string) => observe(id, [{ key: 'event', value: tag }, { key: 'runId', value: RUN }], summary)
const say = (text: string) => runtime.runtimeManager.send(instance, { identityKey: 'streamer', text })

await snapshot('ps:demo-1:0', 1, -200, 5)
await say('开播！这破店我包了')
await say('第3天前我一定让资金转正')
await event('ps-event:demo-kill', 'kill:ai_controlled', '游戏击杀回调：1 名被 AI 控制的来客被击杀')
await event('ps-event:demo-story', 'story:cartel.first_visit', '实际在场来客确认接触派系：FACTION_CARTEL')
await snapshot('ps:demo-2:0', 2, 80, 30)
runtime.runtimeManager.saveSnapshot(instance)
// Keep the demo snapshot fresh so Situation stays readable in the console.
setInterval(() => { clock.advance(2000); void snapshot(`ps:demo-tick-${clock.nowSim()}:0`, 2, 80, 30) }, 10000).unref()

const port = Number(process.env.CONSOLE_DEMO_PORT ?? 8798)
const server = createConsoleServer({ runtime, token: DEMO_TOKEN, port })
const { url } = await server.listen()
console.log(`Console demo: ${url}/  (demo token: ${DEMO_TOKEN})`)
process.on('SIGINT', () => { void server.close().finally(() => { runtime.close(); process.exit(0) }) })
setInterval(() => {}, 1 << 30)
