/**
 * Default guidance from a decided thought to the reply model.
 *
 * Role-agnostic: extensions can replace it (`InstanceExtension.thoughtGuidance`) to phrase
 * decisions in the character's own terms. Guidance is rationale only; it grants nothing.
 */
import type { ThoughtResult } from '../kernel/thinking/types.ts'
import type { ThoughtBrief } from '../runtime/instance-runtime.ts'

/** One line of untrusted text: no line breaks, bounded length. */
export function dataLine(text: string, max = 300): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

export function guidanceFor(thought: ThoughtResult): ThoughtBrief {
  // `decision` is normalized to the vocabulary, so it is safe in the rationale; free text goes to data.
  return {
    guidance: [
      `本轮动作：${thought.decision}`,
      ...(thought.decision === 'ask' ? ['没听清或拿不准：只问一句短的确认，不要编造对方没说的内容。'] : []),
    ],
    data: [
      `对方的意思（推断，把握 ${thought.meantConf.toFixed(2)}）：${dataLine(thought.meant)}`,
      ...(thought.reason ? [`依据：${dataLine(thought.reason)}`] : []),
    ],
  }
}
