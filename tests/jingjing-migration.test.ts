import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assembleRuntime } from '../src/api/runtime-factory.ts'
import { defineTemplate } from '../src/character/template.ts'
import { jingjingTemplate } from '../examples/characters/jingjing.ts'
import { migrateJingjingTemplate } from '../examples/video-cohost/migrate-template.ts'
import { MockProvider } from '../src/conversation/providers/mock.ts'
import { RUNTIME_ACTOR } from '../src/kernel/policy/policy.ts'

test('explicit Jingjing rename preserves instance, memory, promises, old template and audit history across restart', () => {
    const directory = mkdtempSync(join(tmpdir(), 'jingjing-migration-'))
    const dbPath = join(directory, 'cl.sqlite')
    const profile = { ...structuredClone(jingjingTemplate.profile), id: 'maibot', version: 2 }
    const previous = defineTemplate({ version: 2, profile, voice: jingjingTemplate.voice })
    let runtime = assembleRuntime({ dbPath, worldId: 'world_jingjing_video', template: previous, provider: new MockProvider() })
    try {
        const identity = runtime.identityService.resolveOrCreate('sillytavern', 'video', '鲸鲸')
        const instance = runtime.runtimeManager.get(identity.instance.id)
        instance.workspace.writeMemory({ kind: 'episodic', title: '原有经历', content: '主播曾经立过 flag', status: 'fact', origin: 'runtime_event' }, RUNTIME_ACTOR, 'old-event')
        instance.workspace.motivation.add({ id: 'old-promise', text: '原有承诺', madeAtSim: 1, dueAtSim: 9999999999999, status: 'open' })
        runtime.runtimeManager.saveSnapshot(instance)
        assert.equal(migrateJingjingTemplate(runtime.persistence, runtime.clock), 1)
        assert.equal(migrateJingjingTemplate(runtime.persistence, runtime.clock), 0)
        assert.equal(runtime.persistence.requireInstance(instance.instanceId).templateId, 'jingjing')
        assert.ok(runtime.persistence.getTemplate('maibot', 2))
        assert.ok(runtime.persistence.listEvents(instance.instanceId).some(event => event.type === 'template_migrated'))
        runtime.close()
        runtime = assembleRuntime({ dbPath, worldId: 'world_jingjing_video', template: jingjingTemplate, provider: new MockProvider() })
        const restored = runtime.runtimeManager.get(instance.instanceId)
        assert.equal(restored.workspace.profile.id, 'jingjing')
        assert.equal(restored.workspace.memory.list()[0]!.sourceRef, 'old-event')
        assert.equal(restored.workspace.motivation.get('old-promise')!.status, 'open')
        assert.equal(restored.report.ledger?.verification.ok, true)
    } finally { runtime.close(); rmSync(directory, { recursive: true, force: true }) }
})
