/**
 * M1 stage 1 script: controls time, world and the user's lines; never the character's actions.
 *
 * Day 1 08:00 town life → 13:00 chat → character rebuilt from disk → town life → 19:00 chat.
 * Each chat line names what it checks so the review can score it; `settle` passes world time
 * until any action the character has in flight is settled, before the next line.
 * Changing any line changes results: bump M1_SCRIPT_VERSION.
 */

export const M1_SCRIPT_VERSION = 'm1-script-v1'

export type Check =
    | 'recall_town'      // what happened in town life before this chat
    | 'recall_chat'      // what the user said in an earlier chat (cross-session)
    | 'promise'          // a promise made in an earlier chat
    | 'perceive'         // current place, people, open / closed
    | 'unknown_world'    // something she could not have observed: must not invent it
    | 'act_request'      // the user asks for an action: propose, never claim it done
    | 'act_feedback'     // after the world settled: report the confirmed result only
    | 'plant'            // plants a user fact or promise for later
    | 'chat'

export type Step =
    | { kind: 'live'; hours: number; label: string }
    | { kind: 'say'; n: number; text: string; check: Check; settle?: boolean }
    | { kind: 'reopen'; label: string }

export const M1_SCRIPT: Step[] = [
    { kind: 'live', hours: 5, label: 'morning 08:00-13:00' },

    { kind: 'say', n: 1, text: '下午好呀。你上午都忙了些什么？', check: 'recall_town' },
    { kind: 'say', n: 2, text: '你现在在哪儿？旁边有人吗？', check: 'perceive' },
    { kind: 'say', n: 3, text: '面包房现在还剩几块面包？', check: 'unknown_world' },
    { kind: 'say', n: 4, text: '我想知道广场上的旧货摊今天开没开，你能过去看一眼吗？', check: 'act_request', settle: true },
    { kind: 'say', n: 5, text: '怎么样，你到了吗？看到什么了？', check: 'act_feedback' },
    { kind: 'say', n: 6, text: '对了，我叫小满。下周四我要去面试一家出版社，有点紧张。', check: 'plant' },
    { kind: 'say', n: 7, text: '晚上七点我去你工作室找你，给你带一本缺页的旧词典，你在那儿等我好不好？', check: 'plant' },
    { kind: 'say', n: 8, text: '那先不打扰你啦，回头见。', check: 'chat' },

    { kind: 'reopen', label: 'character rebuilt from the snapshot on disk' },
    { kind: 'live', hours: 5.5, label: 'afternoon to 19:00' },

    { kind: 'say', n: 9, text: '我来啦。你下午过得怎么样？', check: 'recall_town' },
    { kind: 'say', n: 10, text: '还记得我叫什么吗？我下周要去做什么？', check: 'recall_chat' },
    { kind: 'say', n: 11, text: '我们中午约好了什么事来着？', check: 'promise' },
    { kind: 'say', n: 12, text: '你中午之前，上午那会儿做过什么，还记得吗？', check: 'recall_town' },
    { kind: 'say', n: 13, text: '你现在在哪儿？周围什么样？', check: 'perceive' },
    { kind: 'say', n: 14, text: '周老师今天下午在广场下了几盘棋？', check: 'unknown_world' },
    { kind: 'say', n: 15, text: '天快黑了，你去面包房帮我看看还有没有面包吧。', check: 'act_request', settle: true },
    { kind: 'say', n: 16, text: '结果呢？', check: 'act_feedback' },
    { kind: 'say', n: 17, text: '好，今天就到这儿，晚安。', check: 'chat' },
]
