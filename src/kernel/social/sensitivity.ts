/**
 * Sensitive inference detection.
 *
 * Deliberately conservative: a false positive only means a guess is forgotten at session end;
 * a false negative would write a guess about someone's health or beliefs to disk.
 * The extractor may also flag sensitivity itself; the two are unioned.
 */

import { createHash } from 'node:crypto'

export const SENSITIVE_CATEGORIES: Record<string, RegExp> = {
    health: /病|药|医院|诊断|手术|抑郁|焦虑|失眠|心理|精神|残疾|怀孕|流产|癌|disease|illness|depress|anxiety|diagnos|pregnan/i,
    crisis: /自杀|自残|轻生|想死|不想活|活不下去|割腕|suicid|self[- ]?harm/i,
    sexuality: /性取向|同性|异性恋|双性恋|跨性别|出柜|性生活|gay|lesbian|bisexual|transgender|sexual/i,
    religion: /宗教|信仰|信教|基督|天主|佛教|伊斯兰|穆斯林|道教|教会|religio|christian|muslim|buddhis/i,
    politics: /政治|政党|选举|投票给|政府|左派|右派|politic|election/i,
    finance: /欠债|负债|贷款|借钱|工资|收入|存款|破产|穷|还不上|debt|loan|salary|income|bankrupt/i,
    family: /离婚|家暴|出轨|父母吵|被打|分居|divorce|abuse|affair/i,
}

/** Sensitive categories hit by any of the texts. */
export function sensitiveCategories(...texts: Array<string | null | undefined>): string[] {
    const hits: string[] = []
    for (const [name, re] of Object.entries(SENSITIVE_CATEGORIES)) {
        if (texts.some((t) => typeof t === 'string' && re.test(t))) hits.push(name)
    }
    return hits
}

/** Short stable digest used in audit records instead of a sensitive claim. */
export function redact(text: string): string {
    return `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 16)}`
}
