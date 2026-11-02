/**
 * 短人设：设置后回复提示只注入短人设、说话风格与内容边界；未设置时与旧版本一致。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildSystemPrompt, CAPABILITY_NOTE, renderProfileSection } from '../../src/conversation/context.ts'
import { shenZhiweiProfile } from '../../examples/characters/shen-zhiwei.ts'
import type { BehaviorDecision, CharacterProfile } from '../../src/types.ts'

function decision(): BehaviorDecision {
  return {
    action: 'respond',
    scores: { respond: 0.5, negotiate: 0.15, decline: 0.1, wait: 0.1, proactive_contact: 0 },
    rationale: ['测试'],
    responseStyle: 'warm_measured',
    proactiveIntent: null,
    proactiveMessage: null,
    nextActionSim: null,
  }
}

describe('short persona', () => {
  it('without a short persona the prompt still carries every profile field', () => {
    const prompt = buildSystemPrompt({ profile: shenZhiweiProfile, decision: decision(), capabilityNote: CAPABILITY_NOTE })
    assert.ok(prompt.includes(shenZhiweiProfile.background))
    assert.ok(prompt.includes(shenZhiweiProfile.relationshipNotes))
    for (const trait of shenZhiweiProfile.traits) assert.ok(prompt.includes(trait))
  })

  it('with a short persona the prompt drops the long fields but keeps style and boundaries', () => {
    const profile: CharacterProfile = { ...shenZhiweiProfile, shortPersona: '一句话的人设。' }
    const prompt = buildSystemPrompt({ profile, decision: decision(), capabilityNote: CAPABILITY_NOTE })
    assert.ok(prompt.includes('人设：一句话的人设。'))
    assert.ok(prompt.includes(profile.name))
    assert.ok(prompt.includes(profile.speechStyle))
    for (const boundary of profile.contentBoundaries) assert.ok(prompt.includes(boundary), `missing boundary ${boundary}`)
    assert.ok(!prompt.includes(profile.background))
    assert.ok(!prompt.includes(profile.relationshipNotes))
    for (const goal of profile.goals) assert.ok(!prompt.includes(goal), `goal leaked: ${goal}`)
    // The non-negotiable rules stay in place.
    assert.ok(prompt.includes('【不可违反的规则】'))
  })

  it('a blank short persona falls back to the full profile', () => {
    const profile: CharacterProfile = { ...shenZhiweiProfile, shortPersona: '   ' }
    assert.equal(renderProfileSection(profile), renderProfileSection(shenZhiweiProfile))
  })
})
