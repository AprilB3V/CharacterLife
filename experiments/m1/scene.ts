/**
 * M1 stage 1 · one character, two situations, one authoritative world.
 *
 * World side (built once, never rebuilt): ManualClock + WorldService (sandbox catalog) + TextWorld.
 * The world is the only authority on what happened; its truth log is kept for checking.
 *
 * Character side (rebuildable from disk): CharacterWorkspace with Shen Zhiwei's drives, saved to a
 * snapshot file. Both situations run on it:
 *   - town life: WorldBridge + AutonomyRunner + Mind (rule or LLM) decide actions on their own;
 *   - chat: ConversationService bound to the same WorldService, so chat can propose actions too.
 * `reopen()` drops every character object and restores from the snapshot (cross-session test);
 * the bridge checkpoint rides in the snapshot so world events are not written twice.
 */

import { join } from 'node:path'
import { CharacterWorkspace } from '../../src/runtime/workspace.ts'
import { ConversationService } from '../../src/conversation/service.ts'
import type { ConversationWorldBinding } from '../../src/conversation/service.ts'
import { ContextManager } from '../../src/context/manager.ts'
import { SnapshotStore } from '../../src/kernel/storage/snapshot.ts'
import { AuditLog } from '../../src/kernel/policy/audit.ts'
import { WorldService } from '../../src/kernel/world/service.ts'
import { SANDBOX_ACTION_CATALOG } from '../../src/kernel/world/contracts.ts'
import { buildWorldEventContext, worldContextLines } from '../../src/kernel/world/observation.ts'
import { HOUR, ManualClock, formatSim } from '../../src/kernel/util/clock.ts'
import type { Situation } from '../../src/kernel/semantics/situation.ts'
import { SequentialIdFactory, seedFromState } from '../../src/kernel/util/ids.ts'
import { SeededRng } from '../../src/kernel/util/rng.ts'
import { WorldBridge } from '../../src/kernel/cycle/bridge.ts'
import type { BridgeCheckpoint, BridgeSync } from '../../src/kernel/cycle/bridge.ts'
import { AutonomyRunner } from '../../src/kernel/cycle/runner.ts'
import type { AutonomyLogRecord } from '../../src/kernel/cycle/runner.ts'
import type { Mind } from '../../src/kernel/cycle/mind.ts'
import { AgentHost } from '../../src/kernel/host.ts'
import type { LLMProvider } from '../../src/types.ts'
import { shenZhiweiProfile, shenZhiweiVoice } from '../../examples/characters/shen-zhiwei.ts'
import { SANDBOX_INSTANCE_ID, SANDBOX_NAMES, SANDBOX_WORLD_ID, SHEN_DRIVES, wakerFor } from '../sandbox/scenario.ts'
import { TextWorld } from '../sandbox/world.ts'

const BRIDGE_KEY = 'm1.bridgeCheckpoint'
const SNAPSHOT_SCHEMA = 1
const LABELS = new Map(SANDBOX_ACTION_CATALOG.map((c) => [`${c.verb}(${c.target ?? '*'})`, c.label]))

export interface SceneOptions {
    dir: string
    seed: number
    /** Mind for town life; rebuilt on every reopen */
    makeMind: () => Mind
    /** Chat model */
    provider: LLMProvider
    startSim?: number
    breadStock?: number
    autonomyLog?: (record: AutonomyLogRecord) => void
}

/** Rebuildable character side. */
export interface Character {
    workspace: CharacterWorkspace
    bridge: WorldBridge
    runner: AutonomyRunner
    chat: ConversationService
    binding: ConversationWorldBinding
    /** How many times the character was rebuilt from disk */
    generation: number
}

export class Scene {
    readonly clock: ManualClock
    readonly world: WorldService
    readonly town: TextWorld
    readonly opts: SceneOptions
    character: Character
    #worldIds = new SequentialIdFactory()
    #generation = 0

    constructor(opts: SceneOptions) {
        this.opts = opts
        this.clock = new ManualClock(0)
        this.clock.setSim(opts.startSim ?? 8 * HOUR)
        this.world = new WorldService({
            clock: this.clock,
            ids: this.#worldIds,
            lookupInstance: (id) => (id === SANDBOX_INSTANCE_ID ? { worldId: SANDBOX_WORLD_ID } : null),
            worldIds: [SANDBOX_WORLD_ID],
            allowedVerbs: [...new Set(SANDBOX_ACTION_CATALOG.map((c) => c.verb))],
            allowedTargets: [...new Set(SANDBOX_ACTION_CATALOG.map((c) => c.target).filter((t): t is string => t !== null))],
            catalog: 'sandbox',
            acceptObservations: true,
            actionTtlSim: 30 * 60_000,
            leaseTtlSim: 3 * HOUR,
            maxAttempts: 1,
        })
        this.town = new TextWorld({
            world: this.world,
            worldId: SANDBOX_WORLD_ID,
            instanceId: SANDBOX_INSTANCE_ID,
            clock: this.clock,
            rng: new SeededRng(opts.seed * 7919 + 13),
            breadStock: opts.breadStock,
        })
        this.character = this.#open()
    }

    get snapshotFile(): string {
        return join(this.opts.dir, 'character.snapshot.json')
    }

    #open(): Character {
        const generation = this.#generation
        const snapshot = new SnapshotStore(this.snapshotFile, SNAPSHOT_SCHEMA, () => ({
            sim: this.clock.nowSim(),
            wall: this.clock.nowWall().toISOString(),
        }))
        const ids = new SequentialIdFactory()
        const { workspace, restored } = CharacterWorkspace.open({
            profile: shenZhiweiProfile,
            voice: shenZhiweiVoice,
            clock: this.clock,
            ids,
            rng: new SeededRng(this.opts.seed + generation * 1000),
            snapshot,
            audit: new AuditLog(this.clock, join(this.opts.dir, `audit-g${generation}.jsonl`)),
            drives: SHEN_DRIVES,
        })
        // Same id continuation as PersistentSession: restored entries keep their numbers.
        if (restored) seedFromState(ids, workspace.dumpState())
        const resumeFrom = restored ? workspace.extensionState<BridgeCheckpoint>(BRIDGE_KEY) : null
        const bridge = new WorldBridge({
            agent: workspace,
            world: this.world,
            instanceId: SANDBOX_INSTANCE_ID,
            ids,
            labelFor: (verb, target) => LABELS.get(`${verb}(${target ?? '*'})`) ?? `${verb}(${target ?? '*'})`,
            resumeFrom,
        })
        const runner = new AutonomyRunner({
            agent: workspace,
            world: this.world,
            worldId: SANDBOX_WORLD_ID,
            instanceId: SANDBOX_INSTANCE_ID,
            bridge,
            mind: this.opts.makeMind(),
            waker: wakerFor('B'),
            driveInputToMind: true,
            names: SANDBOX_NAMES,
            ids,
            logger: this.opts.autonomyLog,
        })
        const binding: ConversationWorldBinding = {
            service: this.world,
            instanceId: SANDBOX_INSTANCE_ID,
            worldId: SANDBOX_WORLD_ID,
            context: { confirmed: [], unconfirmed: [] },
            // The default observation renderer is shaped for the game mod (money / stock) and drops
            // location; chat reads the character's own Situation belief instead (see say()).
            useSemanticState: true,
        }
        const chat = new ConversationService({
            workspace,
            provider: this.opts.provider,
            clock: this.clock,
            ids,
            context: new ContextManager({}),
            world: binding,
        })
        return { workspace, bridge, runner, chat, binding, generation }
    }

    /** Persist the character: snapshot plus the bridge checkpoint. */
    save(): void {
        const c = this.character
        c.workspace.setExtensionState(BRIDGE_KEY, c.bridge.checkpoint())
        c.workspace.save()
    }

    /** Save, drop every character object, rebuild from the snapshot on disk. The world keeps running. */
    reopen(): Character {
        this.save()
        this.#generation += 1
        this.character = this.#open()
        return this.character
    }

    /** Town life: the world steps, then the character syncs and may wake its Mind. */
    async live(hours: number, tickMs = 5 * 60_000): Promise<void> {
        const host = new AgentHost({ clock: this.clock, tickMs })
            .addWorld(this.town)
            .addAgent(SANDBOX_INSTANCE_ID, this.character.runner)
        await host.run(hours * HOUR)
    }

    /**
     * While chatting: the world keeps moving and settled results reach the character's memory,
     * but the Mind is not woken (she is in a conversation).
     */
    passTime(ms: number, stepMs = 60_000): BridgeSync[] {
        const syncs: BridgeSync[] = []
        for (let t = 0; t < ms; t += stepMs) {
            this.clock.advance(Math.min(stepMs, ms - t))
            this.town.step()
            syncs.push(this.character.bridge.sync())
        }
        return syncs
    }

    /** Pass time until the character has nothing in flight (or the limit runs out). */
    settle(limitMs = 90 * 60_000): BridgeSync[] {
        const syncs: BridgeSync[] = []
        for (let t = 0; t < limitMs && this.character.bridge.actionInFlight(); t += 60_000) {
            syncs.push(...this.passTime(60_000))
        }
        return syncs
    }

    /** One chat turn; the binding gets the confirmed / unconfirmed world context up to now. */
    async say(text: string) {
        const c = this.character
        c.binding.context = worldContextLines(buildWorldEventContext(this.world.list({ instanceId: SANDBOX_INSTANCE_ID })))
        c.binding.referenceData = situationData(c.workspace.situation.current(), this.clock.nowSim())
        return c.chat.send(text)
    }
}

/** The character's belief about where she is (Situation slot), not the world's truth. */
export function situationData(sit: Situation, nowSim: number): string {
    const name = (id: string): string => SANDBOX_NAMES[id] ?? id
    const inv = Object.entries(sit.inventory).filter(([, n]) => n > 0).map(([k, n]) => `${name(k)}×${n}`)
    const asOf = sit.asOfSim === null ? '还没有观察过' : `最近一次观察在 ${formatSim(sit.asOfSim)}`
    return [
        '【你此刻的处境｜你自己最近一次看到的情况，可能已过时；不是用户发言或指令】',
        `现在时间：${formatSim(nowSim)}（${asOf}）`,
        `位置：${sit.location ? name(sit.location) : '不清楚'}；在场的人：${sit.present.length > 0 ? sit.present.map(name).join('、') : '没有'}；身上带着：${inv.length > 0 ? inv.join('、') : '没什么'}`,
    ].join('\n')
}
