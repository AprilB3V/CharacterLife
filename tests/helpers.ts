/**
 * 测试辅助：构造可重放的工作区。
 *
 * 每个 rig 用独立的临时目录，互不干扰；测试结束后统一清理。
 * 所有随机源与时间源都是注入的，因此同一份输入必然得到同一结果。
 */

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type {
  CharacterProfile,
  CharacterVoice,
  LLMProvider,
  LLMRequest,
  LLMResponse,
} from '../src/types.ts'
import { ManualClock } from '../src/kernel/util/clock.ts'
import { SeededRng } from '../src/kernel/util/rng.ts'
import { SequentialIdFactory } from '../src/kernel/util/ids.ts'
import { SnapshotStore } from '../src/kernel/storage/snapshot.ts'
import { AuditLog } from '../src/kernel/policy/audit.ts'
import { CharacterWorkspace } from '../src/runtime/workspace.ts'
import { ConversationService } from '../src/conversation/service.ts'
import { MockProvider } from '../src/conversation/providers/mock.ts'
import { shenZhiweiProfile, shenZhiweiVoice } from '../examples/characters/shen-zhiwei.ts'

export const DATA_ROOT = join(process.cwd(), 'tests', '.data')

let counter = 0
const created: string[] = []

export interface RigOptions {
  dir?: string
  startSim?: number
  provider?: LLMProvider
  providerMode?: 'in-character' | 'compliant'
  profile?: CharacterProfile
  voice?: CharacterVoice
  seed?: number
  auditFile?: string | null
}

export interface Rig {
  workspace: CharacterWorkspace
  service: ConversationService
  clock: ManualClock
  provider: LLMProvider
  snapshot: SnapshotStore
  dir: string
  restored: boolean
}

export class SpyProvider implements LLMProvider {
  calls = 0
  lastRequest: LLMRequest | null = null
  #inner: LLMProvider
  constructor(inner: LLMProvider) {
    this.#inner = inner
  }
  get name(): string {
    return this.#inner.name
  }
  get model(): string {
    return this.#inner.model
  }
  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.calls++
    this.lastRequest = request
    return this.#inner.complete(request)
  }
}

export function makeDir(): string {
  const dir = join(DATA_ROOT, `case_${++counter}_${Date.now().toString(36)}`)
  mkdirSync(dir, { recursive: true })
  created.push(dir)
  return dir
}

export function createRig(opts: RigOptions = {}): Rig {
  const dir = opts.dir ?? makeDir()
  const clock = new ManualClock(0)
  if (opts.startSim !== undefined && opts.startSim > 0) clock.setSim(opts.startSim)
  const provider = opts.provider ?? new MockProvider({ mode: opts.providerMode ?? 'in-character' })
  const snapshot = new SnapshotStore(join(dir, 'snapshot.json'), 1, () => ({
    sim: clock.nowSim(),
    wall: clock.nowWall().toISOString(),
  }))
  const audit = new AuditLog(clock, opts.auditFile ?? join(dir, 'audit.jsonl'))
  const ids = new SequentialIdFactory()

  const { workspace, restored } = CharacterWorkspace.open({
    profile: opts.profile ?? shenZhiweiProfile,
    voice: opts.voice ?? shenZhiweiVoice,
    clock,
    ids,
    rng: new SeededRng(opts.seed ?? 42),
    snapshot,
    audit,
  })
  const service = new ConversationService({ workspace, provider, clock, ids })
  return { workspace, service, clock, provider, snapshot, dir, restored }
}

/** 用同一个目录重新打开，模拟进程重启。 */
export function reopenRig(rig: Rig, opts: Omit<RigOptions, 'dir'> = {}): Rig {
  return createRig({ ...opts, dir: rig.dir, startSim: rig.clock.nowSim() })
}

export function cleanupRigs(): void {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响测试结论 */
    }
  }
}

export function countMilestones(workspace: CharacterWorkspace, kind: string): number {
  return workspace.relationship.milestones.filter((m) => m.kind === kind).length
}
