/**
 * 平台内指令。
 *
 * 指令只操作「当前身份对应的实例」，因此天然满足两条约束：
 * - 用户看不到别人的记忆（instance 就是自己的）；
 * - 删除记忆需要经过权限层（OWNER_ACTOR + 身份校验），不是谁喊 `/forget` 就能删。
 *
 * 指令不走模型：省 token，也避免「被注入的指令文本」被当成命令执行。
 */

import type { PlatformIdentity } from '../adapters/protocol.ts'
import type { PlatformStore } from '../persistence/platform-store.ts'
import type { IdentityService } from '../identity/identity-service.ts'
import type { InstanceRuntimeManager, InstanceRuntime } from '../runtime/instance-runtime.ts'
import { OWNER_ACTOR } from '../kernel/policy/policy.ts'

export interface CommandContext {
  runtime: InstanceRuntime
  instanceId: string
  identity: PlatformIdentity
  identityKey: string
  sessionId: string
  runtimeManager: InstanceRuntimeManager
  platformStore: PlatformStore
  identityService: IdentityService
  nowIso: () => string
  /** 该平台期望绑定到的目标平台名（默认 sillytavern） */
  bindTargetPlatform?: string
}

export interface CommandResult {
  handled: boolean
  text: string
}

const HELP = [
  '可用指令：',
  '/help        查看这条帮助',
  '/status      查看当前关系与记忆概览',
  '/newsession  新开一段会话（长期记忆保留）',
  '/memory      查看可管理的个人记忆',
  '/forget <id> 删除某条记忆；/forget all confirm 清空',
  '/quiet on|off 开启/关闭主动联系',
  '/bind        生成一次性验证码，用于绑定其他平台',
  '/unbind      解除当前平台绑定',
].join('\n')

function publicStage(stage: string): string {
  const map: Record<string, string> = {
    stranger: '还不熟',
    acquaintance: '有点熟了',
    familiar: '熟悉',
    friend: '朋友',
    close: '很亲近',
  }
  return map[stage] ?? stage
}

export function handleCommand(input: string, ctx: CommandContext): CommandResult {
  const text = input.trim()
  if (!text.startsWith('/')) return { handled: false, text: '' }
  const [rawCmd, ...args] = text.split(/\s+/)
  const cmd = (rawCmd ?? '').toLowerCase()
  const runtime = ctx.runtime
  const workspace = runtime.workspace

  switch (cmd) {
    case '/help':
      return { handled: true, text: HELP }

    case '/status': {
      const rel = workspace.relationship
      const view = workspace.view()
      const lines = [
        `【${workspace.profile.name}】`,
        `关系：${publicStage(rel.stage)}（信任 ${rel.trust} / 熟悉 ${rel.familiarity}）`,
        `记忆：共同经历 ${view.memory.episodic} 条，关于你的信息 ${view.memory.user} 条`,
        `里程碑：${rel.milestones.length} 个`,
        `当前心情：${view.dynamic.mood.label}`,
        `待发送消息：${view.pendingMessages} 条`,
      ]
      if (runtime.conflicts.length > 0) lines.push(`待处理的记忆冲突：${runtime.conflicts.length} 处`)
      return { handled: true, text: lines.join('\n') }
    }

    case '/newsession': {
      const id = ctx.runtimeManager.newSession(runtime, ctx.identityKey)
      return {
        handled: true,
        text: `已经开了一段新会话（${id.slice(0, 12)}…）。人格、关系、长期记忆都不受影响。`,
      }
    }

    case '/memory': {
      const memories = workspace.memory.list().slice(-12)
      if (memories.length === 0) return { handled: true, text: '目前还没有关于你的记忆。' }
      const lines = memories.map((m) => {
        const tag = m.status === 'fact' ? '事实' : m.status === 'fiction' ? '剧情' : '推测'
        return `· ${m.id}｜${tag}｜${m.title}`
      })
      return { handled: true, text: `我记得的事（最多显示 12 条）：\n${lines.join('\n')}\n用 /forget <id> 可以删除。` }
    }

    case '/forget': {
      if (args[0] === 'all') {
        if (args[1] !== 'confirm') {
          return { handled: true, text: '如果确定清空关于你的所有记忆，请发送：/forget all confirm' }
        }
        const all = workspace.memory.list()
        let removed = 0
        for (const m of all) {
          if (workspace.deleteMemory(m.id, OWNER_ACTOR)) removed++
        }
        return { handled: true, text: `已删除 ${removed} 条记忆（软删除，可审计）。` }
      }
      const id = args[0]
      if (!id) return { handled: true, text: '用法：/forget <记忆id>，或 /forget all confirm' }
      // 只允许删除「属于当前实例」的记忆：workspace 本身就只含本实例数据
      const target = workspace.memory.get(id)
      if (!target) return { handled: true, text: `没有找到记忆 ${id}。` }
      const ok = workspace.deleteMemory(id, OWNER_ACTOR)
      return { handled: true, text: ok ? `已删除记忆 ${id}。` : `删除失败：${id}` }
    }

    case '/quiet': {
      const arg = (args[0] ?? '').toLowerCase()
      const quiet = arg === 'off' ? false : true
      ctx.platformStore.setQuiet(ctx.identity.platform, ctx.identity.platformUserId, quiet, ctx.nowIso())
      if (quiet) {
        const drained = workspace.drainPendingMessages()
        return {
          handled: true,
          text: `好，我不会主动找你了${drained.length > 0 ? `（取消 ${drained.length} 条待发送消息）` : ''}。发 /quiet off 可以恢复。`,
        }
      }
      return { handled: true, text: '好，那我以后可以主动找你了。' }
    }

    case '/bind': {
      const target = ctx.bindTargetPlatform ?? 'sillytavern'
      const issued = ctx.identityService.issueBindCode({
        instanceId: ctx.instanceId,
        targetPlatform: target,
        createdBy: `${ctx.identity.platform}:${ctx.identity.platformUserId}`,
      })
      return {
        handled: true,
        text:
          `绑定码：${issued.code}\n有效期至：${issued.expiresAt}\n` +
          `在 ${target} 侧的管理接口里提交这个码即可共用同一个角色（一次性，最多尝试 3 次）。`,
      }
    }

    case '/unbind': {
      const ok = ctx.identityService.unbind(ctx.identity.platform, ctx.identity.platformUserId)
      return {
        handled: true,
        text: ok
          ? '已解除当前平台的绑定。再发消息会创建一个新的角色实例（旧记忆不会丢失，但不再关联）。'
          : '当前平台本来就没有绑定记录。',
      }
    }

    default:
      // 未知指令按普通对话处理，避免把用户正常输入吞掉
      return { handled: false, text: '' }
  }
}
