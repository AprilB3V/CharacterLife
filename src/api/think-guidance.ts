/**
 * Default guidance from a decided thought to the reply model.
 *
 * Role-agnostic: extensions can replace it (`InstanceExtension.thoughtGuidance`) to phrase
 * decisions in the character's own terms. Guidance is rationale only; it grants nothing.
 */
import type { ThoughtResult } from '../kernel/thinking/types.ts'

export function guidanceFor(thought: ThoughtResult): string[] {
  return [
    `思考结论：对方的意思是「${thought.meant}」（把握 ${thought.meantConf.toFixed(2)}）`,
    `本轮动作：${thought.decision}`,
    ...(thought.reason ? [`依据：${thought.reason}`] : []),
    ...(thought.decision === 'ask' ? ['没听清或拿不准：只问一句短的确认，不要编造对方没说的内容。'] : []),
  ]
}
