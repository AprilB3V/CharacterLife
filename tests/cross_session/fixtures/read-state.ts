/**
 * 子进程脚本：在**另一个独立进程**里恢复同一个角色，输出她记得什么。
 *
 * 用法：node read-state.ts <dbPath> <outJsonPath> <instanceId>
 */

import { writeFileSync } from 'node:fs'
import { CharacterDatabase } from '../../../src/persistence/database.ts'
import { CharacterPersistence } from '../../../src/persistence/store.ts'
import { PersistentSession } from '../../../src/character/persistent-session.ts'
import { ManualClock } from '../../../src/util/clock.ts'
import { SeededRng } from '../../../src/util/rng.ts'
import { SequentialIdFactory } from '../../../src/util/ids.ts'
import { MockProvider } from '../../../src/conversation/providers/mock.ts'

const [dbPath, outPath, instanceId] = process.argv.slice(2)
if (!dbPath || !outPath || !instanceId) {
  console.error('用法: node read-state.ts <dbPath> <outJsonPath> <instanceId>')
  process.exit(2)
}

const db = new CharacterDatabase(dbPath)
const persistence = new CharacterPersistence(db)
const clock = new ManualClock(0)
const ids = new SequentialIdFactory()

const session = PersistentSession.open({
  persistence,
  instanceId,
  provider: new MockProvider({ mode: 'in-character' }),
  clock,
  ids,
  rng: new SeededRng(20250104),
  probeQuery: '被水泡过的书',
})

const recall = await session.send('我回来了，上次说好的那本书呢？')
const view = session.workspace.view()

writeFileSync(
  outPath,
  JSON.stringify(
    {
      pid: process.pid,
      instanceId,
      sessionId: session.session?.id ?? null,
      trust: view.relationship.trust,
      familiarity: view.relationship.familiarity,
      stage: view.relationship.stage,
      milestones: view.relationship.milestones.map((m) => m.id),
      memoryCount: view.memory.total,
      memoryTitles: session.workspace.memory.list().map((m) => m.title),
      traits: session.workspace.profile.traits,
      retrievedMemoryIds: recall.retrievedMemoryIds,
      replayedEvents: session.report.replayedEvents,
      templateHash: session.template.contentHash,
      templateVersion: session.template.version,
      steps: session.report.steps.map((s) => ({ step: s.step, ok: s.ok, detail: s.detail })),
      reply: recall.reply,
    },
    null,
    2,
  ),
  'utf8',
)
session.close('user_exit')
db.close()
