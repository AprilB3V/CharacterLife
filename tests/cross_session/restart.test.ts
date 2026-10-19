/**
 * 跨进程重启恢复。
 *
 * 真正起两个独立 Node 进程：一个写状态，一个读状态。
 * 子进程的输出走文件而不是管道 —— Windows 沙箱禁止带管道的子进程 spawn，
 * 但 `stdio: 'ignore'` 是允许的（这也是本测试必须用文件交换数据的原因）。
 */

import { after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CharacterDatabase } from '../../src/persistence/database.ts'
import { CharacterPersistence } from '../../src/persistence/store.ts'
import { buildTemplate, cleanupDirs, freshDir } from './helpers.ts'
import { shenZhiweiProfile } from '../../examples/characters/shen-zhiwei.ts'

after(() => cleanupDirs())

const here = dirname(fileURLToPath(import.meta.url))
const INSTANCE_ID = 'inst_crossproc'

function runChild(script: string, args: string[]): { status: number | null; signal: string | null } {
  const result = spawnSync(process.execPath, [join(here, 'fixtures', script), ...args], {
    stdio: 'ignore',
    timeout: 60_000,
  })
  return { status: result.status, signal: result.signal }
}

describe('跨进程 · 重启恢复', () => {
  it('进程 A 对话并退出，进程 B 恢复出同样的关系与记忆', () => {
    const dir = freshDir()
    const dbPath = join(dir, 'character.db')
    const writeOut = join(dir, 'write.json')
    const readOut = join(dir, 'read.json')

    // 父进程先把模板与实例建好（模拟「初始化」）
    const template = buildTemplate()
    {
      const db = new CharacterDatabase(dbPath)
      const persistence = new CharacterPersistence(db)
      persistence.putTemplate(template)
      persistence.createInstance(
        { id: INSTANCE_ID, template, playerId: 'player_cross', worldId: 'world_cross', label: '跨进程实例' },
        INSTANCE_ID,
        '2025-01-04T09:00:00.000Z',
      )
      db.close()
    }

    // 进程 A：对话 + 时间推进 + 保存
    const a = runChild('write-state.ts', [dbPath, writeOut, INSTANCE_ID])
    assert.equal(a.status, 0, `进程 A 退出码 ${a.status}（signal=${a.signal}）`)
    assert.ok(existsSync(writeOut), '进程 A 应写出结果文件')
    const written = JSON.parse(readFileSync(writeOut, 'utf8')) as {
      pid: number
      trust: number
      familiarity: number
      memoryCount: number
      traits: string[]
      sessionId: string
      steps: Array<{ step: string; ok: boolean }>
    }
    assert.ok(written.memoryCount > 0, '进程 A 应该写入了记忆')
    assert.deepEqual(written.traits, shenZhiweiProfile.traits)

    // 进程 B：完全独立的进程，恢复并回忆
    const b = runChild('read-state.ts', [dbPath, readOut, INSTANCE_ID])
    assert.equal(b.status, 0, `进程 B 退出码 ${b.status}（signal=${b.signal}）`)
    const read = JSON.parse(readFileSync(readOut, 'utf8')) as {
      pid: number
      trust: number
      familiarity: number
      memoryCount: number
      memoryTitles: string[]
      traits: string[]
      retrievedMemoryIds: string[]
      sessionId: string
      templateHash: string
      steps: Array<{ step: string; ok: boolean }>
    }

    assert.notEqual(read.pid, written.pid, '必须是两个不同的进程')
    assert.equal(read.trust, written.trust, '信任值应跨进程恢复')
    assert.equal(read.familiarity, written.familiarity, '熟悉度应跨进程恢复')
    assert.ok(
      read.memoryCount >= written.memoryCount,
      `记忆不应丢失（新进程又聊了一轮，可能新增）：${read.memoryCount} < ${written.memoryCount}`,
    )
    assert.deepEqual(read.traits, shenZhiweiProfile.traits, '人格不应被改写')
    assert.equal(read.templateHash, template.contentHash)
    assert.ok(read.retrievedMemoryIds.length > 0, '新进程应能检索到旧记忆')
    assert.notEqual(read.sessionId, written.sessionId, '应该是新的会话')
    assert.ok(
      read.steps.every((s) => s.ok),
      `恢复步骤应全部通过：${read.steps.filter((s) => !s.ok).map((s) => s.step).join(',')}`,
    )
  })

  it('进程 B 反复重启后状态保持稳定（不漂移）', () => {
    const dir = freshDir()
    const dbPath = join(dir, 'character.db')
    const outs = [0, 1, 2].map((i) => join(dir, `run${i}.json`))

    const template = buildTemplate()
    {
      const db = new CharacterDatabase(dbPath)
      const persistence = new CharacterPersistence(db)
      persistence.putTemplate(template)
      persistence.createInstance(
        { id: INSTANCE_ID, template, playerId: 'p', worldId: 'w' },
        INSTANCE_ID,
        '2025-01-04T09:00:00.000Z',
      )
      db.close()
    }

    const first = runChild('write-state.ts', [dbPath, outs[0]!, INSTANCE_ID])
    assert.equal(first.status, 0)
    const second = runChild('read-state.ts', [dbPath, outs[1]!, INSTANCE_ID])
    assert.equal(second.status, 0)
    const third = runChild('read-state.ts', [dbPath, outs[2]!, INSTANCE_ID])
    assert.equal(third.status, 0)

    const r1 = JSON.parse(readFileSync(outs[1]!, 'utf8')) as { trust: number; familiarity: number; memoryCount: number; traits: string[] }
    const r2 = JSON.parse(readFileSync(outs[2]!, 'utf8')) as { trust: number; familiarity: number; memoryCount: number; traits: string[] }
    assert.equal(r2.trust, r1.trust, '第二次重启后信任不应漂移')
    assert.equal(r2.familiarity, r1.familiarity)
    assert.ok(r2.memoryCount >= r1.memoryCount, '记忆不应丢失')
    assert.deepEqual(r2.traits, r1.traits)
  })
})
