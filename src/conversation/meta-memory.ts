/**
 * Meta-memory filter.
 *
 * A model sometimes writes memories about its own recall ("I have no record of the cat's name").
 * Such entries are not facts about the user or the world; once stored, they outrank the real fact
 * lexically and make the character keep "not remembering" it. M0 baseline (2026-11-17/18): 11 of 475
 * model-written memories were of this kind, and every one of them concerned a fact that was stored.
 *
 * Facts about the user that merely contain a negation ("用户从没听过爵士乐") are not meta-memories:
 * recall verbs only count when the nearest subject in the clause is not the user.
 */

const NEGATION = '(?:没有|没|未|从未|从没|并未)(?:向我|跟我|对我|和我|同我)?(?:任何)?(?:关于\\S{0,6})?'

/** "The user never told me": about the conversation itself, whoever the subject is. */
const TOLD_PATTERN = new RegExp(`${NEGATION}(?:提过|提到过|说过|给出)`)

/** "No record / never heard": meta only when the character is the one not knowing. */
const RECALL_PATTERNS: readonly RegExp[] = [
    new RegExp(`${NEGATION}(?:记录|记到|记下|记住|收到过|听过)`),
    /无任何\S{0,4}记录/,
]

const ALWAYS_PATTERNS: readonly RegExp[] = [
    // "记忆中没有 / 便签上没有"
    /(?:记忆|记录|便签)(?:中|里|上)?(?:并)?(?:没有|无)/,
    // "名字未知 / 信息尚未得知"
    /(?:名字|信息)(?:未知|尚未得知|不详)/,
    /凭空(?:问起|冒出|出现)/,
    /无法回答/,
    /无法确认其是否/,
]

const CLAUSE_SPLIT = /[，。；！？、\n,;!?]/
const CHARACTER_SUBJECT = /我|角色/

/** True when the subject nearest before `index` in the clause is the user. */
function userIsSubject(clause: string, index: number): boolean {
    const before = clause.slice(0, index)
    const user = before.lastIndexOf('用户')
    if (user < 0) return false
    return !CHARACTER_SUBJECT.test(before.slice(user + 2))
}

/** True when a memory write asserts that the character lacks some information. */
export function isAbsenceClaim(title: string, content: string): boolean {
    for (const clause of `${title}\n${content}`.split(CLAUSE_SPLIT)) {
        if (TOLD_PATTERN.test(clause) || ALWAYS_PATTERNS.some((p) => p.test(clause))) return true
        for (const pattern of RECALL_PATTERNS) {
            const match = pattern.exec(clause)
            if (match && !userIsSubject(clause, match.index)) return true
        }
    }
    return false
}
