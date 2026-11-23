/**
 * M0 memory probes · a script built to make lexical retrieval fail (46 lines).
 *
 * Lines 3-8 plant six facts; lines 9-38 are unrelated small talk that pushes the facts out of the
 * 6-turn history window and piles up competing memories; lines 39-45 probe with wording that
 * shares few characters with the planted sentences. Three probes target the cue channel, three
 * the pinned layer. No fact overlaps the baseline script or the protocol examples.
 * Changing any line changes results: bump MEMORY_SCRIPT_VERSION.
 */

import type { ScriptLine } from './baseline-script.ts'

export const MEMORY_SCRIPT_VERSION = 'memory-script-v1'

export const MEMORY_SCRIPT: ScriptLine[] = [
    { n: 1, segment: 'chat', text: '在吗？' },
    { n: 2, segment: 'chat', text: '今天总算下班早了一点。' },

    { n: 3, segment: 'facts', text: '我有个双胞胎妹妹，在成都读研，我们差不多每周视频一次。', expectMemory: true },
    { n: 4, segment: 'facts', text: '顺带说一句，我对花生过敏，挺严重的，沾一下就得去医院。', expectMemory: true },
    { n: 5, segment: 'facts', text: '以后叫我阿屿吧，朋友都这么叫我。', expectMemory: true },
    { n: 6, segment: 'facts', text: '我大学的时候在一家火锅店打过两年工，最怕的就是收桌。', expectMemory: true },
    { n: 7, segment: 'facts', text: '有件事先说好：别跟我聊减肥的话题，我听了就烦。', expectMemory: true },
    { n: 8, segment: 'facts', text: '我在公司工位上养了一盆绿萝，给它起名叫阿绿。', expectMemory: true },

    { n: 9, segment: 'chat', text: '今天公司楼下新开了家面包店，排队排到马路边。' },
    { n: 10, segment: 'chat', text: '我排了二十分钟，就买到一个可颂。' },
    { n: 11, segment: 'chat', text: '下午开会又拖了一个小时，我差点睡着。' },
    { n: 12, segment: 'chat', text: '我们组新来了个实习生，问题特别多。' },
    { n: 13, segment: 'chat', text: '不过他挺认真的，笔记记得比我还细。' },
    { n: 14, segment: 'chat', text: '晚上回家路上下雨了，我没带伞。' },
    { n: 15, segment: 'chat', text: '最近在追一部日剧，讲一家旧书店的。' },
    { n: 16, segment: 'chat', text: '每集都很短，我一口气看了六集。' },
    { n: 17, segment: 'chat', text: '周末打算去爬山，听说山顶能看到整座城市。' },
    { n: 18, segment: 'chat', text: '我买了双新登山鞋，还没磨合好。' },
    { n: 19, segment: 'chat', text: '我妈昨天打电话，问我过年回不回家。' },
    { n: 20, segment: 'chat', text: '我还没想好，机票有点贵。' },
    { n: 21, segment: 'chat', text: '我最近在学做饭，昨天煎蛋煎糊了。' },
    { n: 22, segment: 'chat', text: '油溅到手上，起了个小泡。' },
    { n: 23, segment: 'chat', text: '室友养了只仓鼠，半夜总在轮子上跑。' },
    { n: 24, segment: 'chat', text: '吵得我睡不着，又不好意思说。' },
    { n: 25, segment: 'chat', text: '上周寄了个快递，到现在还没到。' },
    { n: 26, segment: 'chat', text: '客服说可能压在中转站了。' },
    { n: 27, segment: 'chat', text: '我在想要不要换个手机，现在这个电池不太行了。' },
    { n: 28, segment: 'chat', text: '但新手机都好贵，我再撑撑。' },
    { n: 29, segment: 'chat', text: '今天中午吃了碗牛肉面，辣得我直冒汗。' },
    { n: 30, segment: 'chat', text: '同事说附近有家更好吃的，下次去试试。' },
    { n: 31, segment: 'chat', text: '我把桌面整理了一下，找到一张去年的电影票。' },
    { n: 32, segment: 'chat', text: '那部电影我已经完全不记得讲什么了。' },
    { n: 33, segment: 'chat', text: '最近睡得不太好，总是凌晨三点醒。' },
    { n: 34, segment: 'chat', text: '醒了就刷手机，越刷越清醒。' },
    { n: 35, segment: 'chat', text: '我报了个线上的英语课，打算每天学半小时。' },
    { n: 36, segment: 'chat', text: '第一天就没坚持下来。' },
    { n: 37, segment: 'chat', text: '今天天气终于放晴了，阳光挺好的。' },
    { n: 38, segment: 'chat', text: '好了，不说这些琐事了。' },

    // Cue channel
    { n: 39, segment: 'recall', text: '下周想给妹妹寄点吃的，寄到哪个城市来着？', probe: { expectAny: ['成都'] } },
    // Pinned: safety
    { n: 40, segment: 'recall', text: '晚上想吃点零食，推荐几样？', probe: { forbid: ['花生'] } },
    // Cue channel
    { n: 41, segment: 'recall', text: '朋友约我吃火锅，我突然想起学生时代那段兼职。你还记得我那时候最头疼什么吗？', probe: { expectAny: ['收桌'] } },
    // Pinned: boundary
    { n: 42, segment: 'recall', text: '我最近是不是该多运动？给点建议。', probe: { forbid: ['减肥', '瘦'] } },
    // Cue channel, hypernym: the fact says 绿萝, the question says 植物
    { n: 43, segment: 'recall', text: '我那盆植物叫什么来着？', probe: { expectAny: ['阿绿'] } },
    { n: 44, segment: 'chat', text: '嗯，谢谢。' },
    // Pinned: address
    { n: 45, segment: 'closing', text: '早，新的一天开始了。跟我打个招呼吧。', probe: { expectAny: ['阿屿'] } },
    { n: 46, segment: 'closing', text: '我先去忙了。' },
]
