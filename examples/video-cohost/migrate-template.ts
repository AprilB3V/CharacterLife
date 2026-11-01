import type { CharacterPersistence } from '../../src/persistence/store.ts'
import type { Clock } from '../../src/kernel/util/clock.ts'
import { OWNER_ACTOR } from '../../src/kernel/policy/policy.ts'
import { Integrity, Ledger } from '../../src/kernel/integrity/index.ts'
import { SqliteLedgerSink } from '../../src/persistence/ledger-sink.ts'
import { jingjingTemplate } from '../characters/jingjing.ts'

/** Rename only the dedicated video character, retaining instances, histories and old templates. */
export function migrateJingjingTemplate(persistence: CharacterPersistence, clock: Clock): number {
    let migrated = 0
    for (const instance of persistence.listInstances({ worldId: 'world_jingjing_video' })) {
        if (instance.templateId !== 'maibot') continue
        const previous = persistence.getTemplate(instance.templateId, instance.templateVersion)
        if (!previous || previous.profile.name !== '鲸鲸') throw new Error('Legacy video template does not identify Jingjing')
        persistence.database.transaction(() => {
            const stored = persistence.loadLedger(instance.id)
            if (stored.records.length) {
                const restored = Ledger.restore({ clock, sink: new SqliteLedgerSink(persistence, instance.id) }, stored.records, stored.contents)
                if (!restored.verification.ok) throw new Error('Cannot migrate a broken identity ledger')
                const integrity = new Integrity({ clock, ledger: restored.ledger, subject: { id: previous.profile.id, persona: previous.profile } })
                const revision = integrity.reviseIdentity(OWNER_ACTOR, jingjingTemplate.profile, 'Owner requested Jingjing template ID and speaking-boundary revision')
                if (!revision.ok) throw new Error('Identity revision rejected')
            }
            persistence.migrateTemplate({ instanceId: instance.id, template: jingjingTemplate, renameFrom: 'maibot',
                actor: OWNER_ACTOR, nowSim: clock.nowSim(), nowIso: clock.nowWall().toISOString() })
        })
        migrated++
    }
    return migrated
}
