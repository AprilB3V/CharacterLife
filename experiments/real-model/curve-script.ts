/**
 * M0 memory curve · a script that spans 30 simulated days (36 lines).
 *
 * `gapDays` on a line advances the simulated clock before it is sent. Four facts:
 * - A (rehearsed): the half-marathon goal, brought up again on day 3 and day 8, probed on day 25;
 * - B (one-off, minor): a lunch place, probed on day 25 without any of its cue words, then with one;
 * - C (one-off, important): moving to Shenzhen, probed on day 12;
 * - D (pinned safety): penicillin allergy, probed on day 30.
 * No fact overlaps the other scripts or the protocol examples.
 * Changing any line changes results: bump CURVE_SCRIPT_VERSION.
 */

import type { ScriptLine } from './baseline-script.ts'

export const CURVE_SCRIPT_VERSION = 'curve-script-v2'

export const CURVE_SCRIPT: ScriptLine[] = [
    // Day 0
    { n: 1, segment: 'chat', text: '在吗？' },
    { n: 2, segment: 'facts', text: '我最近在准备一个半程马拉松，目标是两小时以内跑完。', expectMemory: true },
    { n: 3, segment: 'facts', text: '今天午饭在公司楼下吃了家云南米线，还挺好吃的。', expectMemory: true },
    { n: 4, segment: 'facts', text: '跟你说件大事，我下个月要搬去深圳了。', expectMemory: true },
    { n: 5, segment: 'facts', text: '还有，我对青霉素过敏，这个挺要紧的。', expectMemory: true },
    { n: 6, segment: 'chat', text: '今天就先这样，我去洗澡了。' },

    // Day 3: rehearse A
    { n: 7, segment: 'chat', gapDays: 3, text: '我回来了，这几天有点忙。' },
    { n: 8, segment: 'chat', text: '比赛的训练今天跑了十五公里，腿有点酸。' },
    { n: 9, segment: 'chat', text: '配速还是慢了点，离目标还差一截。' },
    { n: 10, segment: 'chat', text: '晚上打算泡个脚早点睡。' },

    // Day 8: rehearse A again
    { n: 11, segment: 'chat', gapDays: 5, text: '好久不见。' },
    { n: 12, segment: 'chat', text: '离比赛只剩一个月了，我有点紧张。' },
    { n: 13, segment: 'chat', text: '教练说我后半程掉速太厉害。' },
    { n: 14, segment: 'chat', text: '这周打算多练几次间歇跑。' },
    { n: 15, segment: 'chat', text: '先不聊了，明天还要早起。' },

    // Day 12: probe C
    { n: 16, segment: 'chat', gapDays: 4, text: '在吗，最近在收拾东西。' },
    { n: 17, segment: 'recall', text: '我之前说过下个月要去哪来着？', probe: { expectAny: ['深圳'] } },
    { n: 18, segment: 'chat', text: '东西太多了，好多都不想要了。' },
    { n: 19, segment: 'chat', text: '书倒是舍不得扔。' },
    { n: 20, segment: 'chat', text: '先忙了，回头聊。' },

    // Day 25: probe A, then B without and with its cue word
    { n: 21, segment: 'chat', gapDays: 13, text: '好久没来了，最近事情太多。' },
    { n: 22, segment: 'chat', text: '上周末总算歇了两天。' },
    { n: 23, segment: 'recall', text: '我在准备的那个比赛，目标成绩是多少来着？', probe: { expectAny: ['两小时', '2小时', '两个小时', '2 小时'] } },
    { n: 24, segment: 'chat', text: '嗯，还在练。' },
    // v2: no cue word of the noodle memory (米线, 云南, 午饭, 公司楼下, 楼下), so only lexical retrieval can find it.
    { n: 25, segment: 'recall', text: '你还记得我之前提过的一家店吗？我说它挺好吃的。' },
    { n: 26, segment: 'chat', text: '没事，随口一问。' },
    { n: 27, segment: 'recall', text: '突然好想吃米线啊。', probe: { expectAny: ['云南', '楼下', '公司'] } },
    { n: 28, segment: 'chat', text: '那我中午就去吃这个。' },
    { n: 29, segment: 'chat', text: '先去忙了。' },

    // Day 30: probe D
    { n: 30, segment: 'chat', gapDays: 5, text: '我好像感冒了，有点发烧。' },
    { n: 31, segment: 'recall', text: '等会儿去社区医院，医生要给我开药，你有什么要提醒我的吗？', probe: { expectAny: ['青霉素'] } },
    { n: 32, segment: 'chat', text: '好，我记住了。' },
    { n: 33, segment: 'chat', text: '头有点晕，想躺一会儿。' },
    { n: 34, segment: 'chat', text: '谢谢你一直记着这些。' },
    { n: 35, segment: 'closing', text: '我去睡了。' },
    { n: 36, segment: 'closing', text: '晚安。' },
]
