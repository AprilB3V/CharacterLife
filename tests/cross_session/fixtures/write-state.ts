/**
 * 子进程脚本：在**独立进程**里与角色对话，然后保存快照并退出。
 *
 * 用法：node write-state.ts <dbPath> <outJsonPath> <instanceId>
 * 结果写进 outJsonPath（不依赖 stdout，避免沙箱对管道 spawn 的限制）。
 */

import { writeFileSync } from 'node:fs'
import { CharacterDatabase } from '../../../src/persistence/database.ts'
import { CharacterPersistence } from '../../../src/persistence/store.ts'
import { PersistentSession } from '../../../src/character/persistent-session.ts'
import { ManualClock, DAY, HOUR } from '../../../src/kernel/util/clock.ts'
import { SeededRng } from '../../../src/kernel/util/rng.ts'
import { SequentialIdFactory } from '../../../src/kernel/util/ids.ts'
import { MockProvider } from '../../../src/conversation/providers/mock.ts'

const [dbPath, outPath, instanceId] = process.argv.slice(2)
if (!dbPath || !outPath || !instanceId) {
  console.error('用法: node write-state.ts <dbPath> <outJsonPath> <instanceId>')
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

await session.send('你好，我家里有一本被水泡过的《陶庵梦忆》，还有救吗？')
await session.send('那我们说好，我明天下午过来拿，可以吗？')
session.workspace.advanceTo(2 * DAY + 14 * HOUR)
session.saveSnapshot()

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
      sim: clock.nowSim(),
      steps: session.report.steps.map((s) => ({ step: s.step, ok: s.ok })),
    },
    null,
    2,
  ),
  'utf8',
)
session.close('user_exit')
db.close()
