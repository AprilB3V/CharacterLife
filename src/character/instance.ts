/**
 * Character Instance 与 Session —— 「谁的角色」和「哪一次聊天」。
 *
 * - Instance：绑定某个 Template 版本 + 某个玩家/世界，承载关系、记忆、剧情进度。
 *   一个 Template 可以被很多 Instance 使用；一个 Instance 只有一个 Template 绑定。
 * - Session：一次聊天上下文（可清空、可重建）。Session 关闭不影响 Instance 的任何状态，
 *   这正是「新会话里人格仍然连续」的关键。
 */

import type { CharacterTemplate } from './template.ts'

export interface CharacterInstance {
  id: string
  templateId: string
  templateVersion: number
  templateHash: string
  playerId: string
  worldId: string
  label: string
  createdAtWall: string
  lastActiveAtWall: string
}

export interface CreateInstanceInput {
  id?: string
  template: CharacterTemplate
  playerId: string
  worldId: string
  label?: string
  createdAtWall?: string
}

export type SessionEndReason = 'user_exit' | 'context_exhausted' | 'crashed' | 'rotation' | 'unknown'

export interface SessionRecord {
  id: string
  instanceId: string
  startedAtWall: string
  endedAtWall: string | null
  turnCount: number
  endReason: SessionEndReason | null
  summary: string | null
}

export function createInstanceRecord(input: CreateInstanceInput, id: string, nowIso: string): CharacterInstance {
  if (!input.playerId) throw new Error('Instance 必须属于一个 playerId')
  if (!input.worldId) throw new Error('Instance 必须属于一个 worldId')
  return {
    id: input.id ?? id,
    templateId: input.template.id,
    templateVersion: input.template.version,
    templateHash: input.template.contentHash,
    playerId: input.playerId,
    worldId: input.worldId,
    label: input.label ?? `${input.template.profile.name} · ${input.playerId}`,
    createdAtWall: input.createdAtWall ?? nowIso,
    lastActiveAtWall: nowIso,
  }
}

export function createSessionRecord(id: string, instanceId: string, nowIso: string): SessionRecord {
  return {
    id,
    instanceId,
    startedAtWall: nowIso,
    endedAtWall: null,
    turnCount: 0,
    endReason: null,
    summary: null,
  }
}
