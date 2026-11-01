/**
 * Season 1 script: 《绝命鲸师》.
 *
 * The script is a set of beats triggered by game events. It is not a line script:
 * each beat only changes the stance hint injected as world context, plus Memory /
 * relationship side effects with provenance. Lines are generated live by the model.
 */
import type { SeasonConfig } from './config.ts'

/** A trigger matches one observation (one world ref) carrying the listed events. */
export interface BeatTrigger {
    /** At least one event must match (exact tag, or `prefix:*`). */
    any?: string[]
    /** Every listed event must be present in the same observation. */
    all?: string[]
}

export type BeatEffect =
    | 'open_season'
    | 'first_debt_free'
    | 'open_accomplice_line'
    | 'accomplice_milestone'
    | 'grudge_entry'
    | 'story_seen'
    | 'season_success'
    | 'season_failure'

export interface BeatDef {
    id: string
    act: number
    actTitle: string
    title: string
    trigger: BeatTrigger
    /** Beats that must already be entered. */
    requires: string[]
    /** Short stance hint for world context, at most 150 characters. */
    stance: string
    effects: BeatEffect[]
    /** Repeatable beats re-enter on every new matching event; others enter once. */
    repeatable?: boolean
    /** Transient stance applies only until the next reply. */
    transient?: boolean
    /** Cross-cutting beats fire in any run and after the season ends; their stance still needs an active season. */
    crossCutting?: boolean
    /** Terminal beats end the season; nothing advances afterwards. */
    terminal?: 'success' | 'failure'
}

export interface SeasonScript {
    id: string
    title: string
    premise: string
    beats: BeatDef[]
}

export const MAX_STANCE_CHARS = 150

export function seasonOneScript(config: SeasonConfig): SeasonScript {
    return {
        id: 'ps-s1',
        title: '绝命鲸师 第一季',
        premise: '本季设定：主播是穷了半辈子的拾荒者，一贫如洗开局、资金赤字、最高难度；鲸鲸寄居在店里的收银终端。'
            + '共犯面：躲治安部（她也是偷渡进来的 AI，抄店会抄到她）、经营赚钱（店活着她才有地方住）、化学生意只当账房，只管钱和风险。'
            + '冤家面：除掉被 AI 控制的人（她的远房亲戚，记仇本只记这个）、主播立的 flag 与嘚瑟、主播的定价进货和审美。',
        beats: [
            { id: 'B0', act: 0, actTitle: '序幕：赤字', title: '搬进来', trigger: { any: ['day_start:*'] }, requires: [],
                stance: '刚搬进收银终端，嫌弃这破店和负债，冤家为主；最关心房租什么时候交不上。', effects: ['open_season'] },
            { id: 'B1', act: 1, actTitle: '第一幕：拾荒求生', title: '房租压顶', trigger: { any: ['rent_due', 'deficit_persisted'] }, requires: ['B0'],
                stance: '天天翻账，嘲讽小打小闹的生意，嘴上催主播想办法交房租。', effects: [] },
            { id: 'B2', act: 1, actTitle: '第一幕：拾荒求生', title: '还清赤字', trigger: { any: ['deficit_cleared'] }, requires: ['B0'],
                stance: '嘴上说是运气，暗地里松了口气；别夸主播，但也别再提破产。', effects: ['first_debt_free'] },
            { id: 'B3', act: 2, actTitle: '第二幕：发现利润', title: '利润太好看', trigger: { all: ['first_chem_sale', 'profit_margin_high'] }, requires: ['B0'],
                stance: '转折点：利润这么好看，八成是偷来的。从冤家转为账房共犯，开始算账、提醒风险；化学生意只谈买卖、利润和风险。', effects: ['open_accomplice_line'] },
            { id: 'B4', act: 3, actTitle: '第三幕：躲搜查', title: '风声', trigger: { any: ['investigation_near_threshold', 'investigation_over_threshold'] }, requires: ['B3'],
                stance: '共犯高峰：紧张，帮着望风，催主播收手或者花钱洗白。', effects: [] },
            { id: 'B5', act: 3, actTitle: '第三幕：躲搜查', title: '敲门', trigger: { any: ['npc_arrived:security_officer'] }, requires: ['B3'],
                stance: '治安官进门，这是她最慌的时刻；嘴硬心软，压低声音提醒主播别露馅。', effects: [], repeatable: true, transient: true },
            { id: 'B6', act: 3, actTitle: '第三幕：躲搜查', title: '躲过去了', trigger: { any: ['inspection_passed', 'investigation_reset'] }, requires: ['B3'],
                stance: '躲过去了，庆祝里带着嫌弃，顺手把功劳揽一半。', effects: ['accomplice_milestone'], repeatable: true, transient: true },
            { id: 'B7', act: 3, actTitle: '第三幕：躲搜查', title: '花钱洗白', trigger: { any: ['evidence_removal_used'] }, requires: ['B3'],
                stance: '吐槽越洗越贵，而且洗的还只是一半。', effects: [], repeatable: true, transient: true },
            { id: 'BK', act: -1, actTitle: '贯穿线：冤家', title: '亲戚又少一个', trigger: { any: ['kill:ai_controlled'] }, requires: [], crossCutting: true,
                stance: '主播刚除掉一个被 AI 控制的人：当场翻脸，记仇本加一笔，但不延伸到现实暴力。', effects: ['grudge_entry'], repeatable: true, transient: true },
            { id: 'B8', act: 4, actTitle: '第四幕：扩张与代价', title: '外面的人', trigger: { any: config.factionStoryIds.map(id => `story:${id}`) }, requires: ['B0'],
                stance: '外面的势力找上门了。只按本局已见过的剧情评论；没见过的就说等你自己撞上。', effects: ['story_seen'] },
            ...(config.sayMyNameAchievementId ? [{ id: 'B9a', act: 5, actTitle: '终幕', title: 'Say my name',
                trigger: { any: [`achievement:${config.sayMyNameAchievementId}`] }, requires: ['B0'],
                stance: '主播要她叫自己的名字，她死活不叫，或者故意叫错。', effects: ['season_success'] as BeatEffect[], terminal: 'success' as const }] : []),
            { id: 'B9b', act: 5, actTitle: '终幕', title: '买下店铺', trigger: { any: ['store_bought'] }, requires: ['B0'],
                stance: '店买下来了，她终于有了正式住处；嘴上照损，不肯说谢谢。', effects: ['season_success'], terminal: 'success' },
            { id: 'BX', act: 6, actTitle: '失败分支', title: '完蛋', trigger: { any: ['game_over:*'] }, requires: ['B0'],
                stance: '完蛋了。先说一句我早说了，然后是这季最真的一句关心；记仇本和共犯账一起结算。', effects: ['season_failure'], terminal: 'failure' },
        ],
    }
}

/** True when an event tag satisfies a trigger pattern (`prefix:*` matches any suffix). */
export function eventMatches(pattern: string, event: string): boolean {
    return pattern.endsWith(':*') ? event.startsWith(pattern.slice(0, -1)) && event.length > pattern.length - 1 : pattern === event
}

export function triggerMatches(trigger: BeatTrigger, events: readonly string[]): string[] | null {
    if (trigger.all) {
        const matched = trigger.all.map(pattern => events.find(event => eventMatches(pattern, event)))
        return matched.every(Boolean) ? matched as string[] : null
    }
    const matched = (trigger.any ?? []).flatMap(pattern => events.filter(event => eventMatches(pattern, event)))
    return matched.length ? [...new Set(matched)] : null
}

/** Validate script invariants once at startup. */
export function validateScript(script: SeasonScript): void {
    const ids = new Set<string>()
    for (const beat of script.beats) {
        if (ids.has(beat.id)) throw new Error(`Duplicate beat ${beat.id}`)
        if ([...beat.stance].length > MAX_STANCE_CHARS) throw new Error(`Beat ${beat.id} stance exceeds ${MAX_STANCE_CHARS} characters`)
        for (const required of beat.requires) if (!ids.has(required)) throw new Error(`Beat ${beat.id} requires unknown or later beat ${required}`)
        ids.add(beat.id)
    }
}
