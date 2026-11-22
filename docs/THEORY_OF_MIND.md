# 他人心智模型（Theory of Mind）· 设计草案

> 状态：T0 已实现（2026-11-21，`src/kernel/social/`，`tests/social.test.ts`），排入 **M1**。目标：角色在维护自我模型之外，维护对"他人意图与情绪"的揣测。

## 0. 定位：可插拔的社交认知模块（已定，2026-11-21）

本阶段只验证"他人模型能否改善真实互动"，所以它是一个**可插拔模块**，不是内核的第七个槽：

- **入口独立**：`characterlife/social`，内核入口 `characterlife/kernel` 不导出它，内核表面不变（有测试）。
- **一键关闭**：`createSocialCognition({ enabled: false })` 返回同接口的空实现，不读不写不出声。T3 的对照组与实验组只差这一个开关。
- **可回滚**：全部持久状态是一个纯 JSON（扩展状态键 `social.v1`）。停机时删除这个键就是回滚；运行中要回滚，调用 `reset()`（否则运行中的实例下次变更会把状态写回）。版本不认识、记录畸形或含敏感词时按空状态 / 丢弃加载，不报错；`forget(id)` 按人清除。
- **不写内核状态**：模块只产出变更记录（带语义标签）和视图。把可晋升的长期推测写进记忆，由宿主决定（T1）。
- **不反向塑造 Self**：关系经历反过来影响自我模型，留到下一阶段。

> 下文 §1–§2 说的"落点"指语义归属（审计标签），不是写进内核状态路径。
> 原则：**揣测是假设，不是事实**。它必须能衰减、能被推翻；敏感推断不长期保存。

## 1. 不新增语义槽，复用现有四个

| 原型概念 | 落点 | 理由 |
|---|---|---|
| 观察 | Observation（不变） | 对方的话、动作、沉默都是 Percept，是证据来源 |
| 短期互动状态 | **Situation 语义**下的 `others.<id>.now` | 和 Situation 同性质：由观察推出的信念，会过时 |
| 长期他人模型 | **Memory 语义**下的 `others.<id>.model` | 与 `relationship.*` 同理：关系是对他人的记忆与认识 |
| 选择行动 | Motivation + Affordance | 优先回应当下社交意图；揣测只体现在回应里，不解释、不确认、不汇报；`check(<hypothesis>)` 仅作例外（§3） |

T0 不改 Policy 白名单：模块自管状态，每次变更返回 `SocialChange`（带 `semantic`）。T1 由宿主把这些记录写进审计；晋升到记忆的那一步才走 `submitProposals → PolicyEngine`。
按人分键（`<id>`），陪伴场景是用户，箱庭里角色之间互相建模（来源是 `Situation.present`）。

## 2. 数据结构

```ts
type HypothesisKind =
    | 'intent'        // what they are trying to do now
    | 'emotion'       // how they likely feel now
    | 'focus'         // what topic they care about now
    | 'expectation'   // what they expect me to do next (a prediction)
    | 'preference'    // communication style, likes / dislikes
    | 'relation'      // shared history / relationship facts

interface Hypothesis {
    id: string
    about: string                 // person id
    kind: HypothesisKind
    claim: string                 // e.g. "wants comfort, not advice"
    confidence: number            // 0..1
    support: string[]             // observation / memory refs
    against: string[]
    status: 'open' | 'confirmed' | 'refuted' | 'expired'
    sensitivity: 'normal' | 'sensitive'
    createdAtSim: number
    lastEvidenceSim: number
    halfLifeMs: number            // by kind; see §4
}

interface OtherModel {            // long-term, memory semantic
    about: string
    confirmed: Hypothesis[]       // stated or verified; becomes MemoryEntry(fact, confirmed=true)
    pending: Hypothesis[]         // long-term but unverified; MemoryEntry(speculation)
}

interface InteractionState {      // short-term, situation semantic
    about: string
    asOfSim: number
    live: Hypothesis[]            // intent / emotion / focus / expectation only
}
```

长期侧不发明新存储：`confirmed` 落成 `MemoryEntry{ status:'fact', confirmed:true }`，
`pending` 落成 `MemoryEntry{ status:'speculation', origin:'character_inference' }`，
沿用现有的遗忘曲线（`memory/curve.ts`）与冲突检测（`memory/conflicts.ts`）。
短期侧是新的轻量 store，与 `SituationStore` 同构（纯函数 `applyPercept` 风格）。

### 2.1 线索规则：按人记忆的情绪权重

抽取以 LLM 为主（§3）。规则不手写，由角色（bot）在使用中**提议**，经 Policy 准入后生效，
作用是给 LLM 提供"这个人的表达习惯"的参考与先验，相当于对象专属的情绪权重记忆。

```ts
interface CueRule {
    id: string
    about: string                 // person id; '*' only via human review
    cue: string                   // surface pattern, e.g. "哈哈哈" / "嗯。" / long silence
    implies: { kind: HypothesisKind; claim: string }   // e.g. emotion: "awkward, not amused"
    weight: number                // -1..1; signed evidence strength fed to §3 step 2
    hits: number                  // prediction confirmed after this cue fired
    misses: number
    status: 'proposed' | 'active' | 'retired'
    proposedAtSim: number
    sourceRefs: string[]          // observations that motivated the proposal
}
```

- **提议**：LLM 在抽取输出里可附带 `ruleProposals`（"他说'嗯。'时多半不想继续"），走 `submitProposals`，路径 `others.<id>.cues`（memory 语义）。
- **准入**：新规则先 `proposed`，只作为参考文本给 LLM，不参与置信更新；累计 `hits ≥ N` 且命中率达标后转 `active`，才把 `weight` 计入证据强度。
- **权重学习**：规则触发后，用 §3 第 4 步的预测反馈更新 `hits / misses`，`weight` 随命中率调整；命中率长期过低 → `retired`。
- **敏感**：命中敏感类别的规则不允许提议（§5）。
- **渲染**：每轮只把与当前对象相关、已触发的 active 规则（以及少量 proposed）放进抽取提示词的数据区，带命中率。

## 3. 循环：观察 → 更新假设 → 选择行动 → 接收反馈 → 修正

1. **观察**：新 Percept 进 Observation。
2. **更新假设**（纯函数，可回放）：
   - 抽取：LLM 结构化输出为主，输入带上该对象的线索规则（§2.1）与当前活跃假设，
     产出 `{kind, claim, evidenceRef, direction: support|against}`，可附带 `ruleProposals`；
     LLM 失败或超预算时只跑 active 规则做降级抽取；
   - 合并：同 `about+kind` 下语义相近的 claim 合并，否则新建；
   - 置信度：支持 `c ← c + w·(1−c)`，反驳 `c ← c·(1−w)`，`w` 按证据强度（明说 > 行为 > 语气）。
3. **选择行动**：Mind 快照只给每人 top-k 活跃假设，并按置信度分档渲染（"大概 / 也许 / 不确定"）。
   规则（2026-11-22 用户定）：
   - **优先回应当下的社交意图**：先接住对方此刻要的东西（想被安慰就安慰，想要答案就给答案，想闲聊就接话），
     而不是先处理自己的推测。
   - **没有必要就不解释、不确认、不汇报**：不说"我感觉你可能……"，不复述自己的判断，
     不播报"我记住了 / 我注意到了"。揣测只体现在回应的内容和语气里，不说出口。
   - `check`（委婉求证）是例外，不是常规：只有"猜错会明显伤到对方或误事，且不问就没法回应当下意图"时才用，
     一轮最多一次，并且要融在回应里，不单独发问。
   - 不得把揣测当事实说出口（原规则保留）。

   T1 验收据此加两项：求证类回复占比（应很低）、"自我解释 / 汇报"句子数（目标 0）。
4. **接收反馈**：`expectation` 类假设自带**预测**（"他接下来会追问细节"）。下一轮观察对照预测：命中加分，落空减分。
   这是唯一能自动校准的信号，也是后面评估的主指标。
5. **修正**：`c < 0.15` → `refuted`；对方明确否认 → 直接 `refuted` 并记录 `against`；
   明确确认 → `confirmed`，晋升为长期事实。

## 4. 衰减与推翻

| kind | 半衰期（初值） | 会话间隔后 |
|---|---|---|
| emotion | 约 20 分钟 | 清空 |
| intent / focus / expectation | 约 1 小时或 10 轮 | 清空 |
| preference（pending） | 走记忆曲线，基础稳定度减半 | 保留 |
| relation（pending） | 走记忆曲线 | 保留 |

- 短期假设**从不自动晋升**为长期。`confirmed` 只能来自对方明说（stated）。preference / relation 两类满足"≥3 个独立会话支持、无反驳、非敏感"时 `promotable()` 返回它，由宿主决定是否作为 speculation 写进记忆。
- 推翻不物理删除：`refuted` 保留证据链（与记忆软删除一致），但不再进上下文。
- 与 `conflicts.ts` 对接：新确认的事实与旧 pending 矛盾时，旧的自动标 `refuted`（这里允许自动，因为被推翻的是推测，不是事实）。

## 5. 敏感推断

- 敏感类别：健康 / 心理危机、性取向、宗教、政治、财务、家庭冲突等（规则词表 + 抽取器打标）。
- `sensitive` 假设：**只活在短期侧**，会话结束即丢；不晋升、不写 SQLite、不进长期记忆。
- 对方自己**明说**的敏感信息不算推断，按现有用户记忆规则处理（是否保存遵循已有边界/钉选机制）。
- **与完整性层的冲突**：账本是哈希链、只追加。敏感假设的审计事件只记 `{id, kind, sensitivity, hash}`，
  不记 `claim` 原文；这样链仍可核对，内容不落盘。需要在 `CONSTITUTION.md` 补一条说明。
- 渲染约束：敏感情绪推断只能用来调整语气，不能被角色复述成"你是不是 XX"。

## 6. 分期（均属 M1）

| 阶段 | 内容 | 验收 |
|---|---|---|
| T0 | 类型、纯函数（合并 / 置信更新 / 衰减 / 敏感打标 / 线索规则状态机）、路径白名单与语义归属 | 单测；边界测试（kernel 零依赖）通过 |
| T1 | 陪伴接入：每轮 LLM 抽取、规则提议与准入、快照渲染、`check` 动作、预测-反馈；**含 QQ 群聊多对象**（按发言者分键，群内只对近期发言者维护短期状态） | 回放录制对话（单聊 + 群聊），预测命中率与 Brier 分数可算；群聊中假设不串人 |
| T2 | 箱庭多角色互相建模（错误信念场景：A 不在场时状态变了） | Sally-Anne 式场景通过 |
| T3 | 弗兰肯斯坦实验加 ToM 消融组 | 有 / 无 ToM 的对照报告 |

## 7. 评估指标

- 预测命中率（expectation 对下一轮）；置信度校准（Brier）；
- 错误假设存活时长（被反驳后多久不再影响回复）；
- 敏感泄漏：长期存储与账本原文中敏感 claim 数应为 0；
- 主观：用户是否觉得"被理解"而不是"被揣测"。

- 规则质量：active 规则命中率、被 retired 的比例、规则对 LLM 抽取预测命中率的增益（有 / 无规则参考对照）。

## 7.5 T0 实现说明

| 文件 | 内容 |
|---|---|
| `src/kernel/social/types.ts` | 假设、线索规则、状态、配置、变更记录、视图 |
| `src/kernel/social/hypotheses.ts` | 置信更新、衰减、分档、claim 归一化匹配、可晋升判定、默认参数 |
| `src/kernel/social/sensitivity.ts` | 敏感词表（健康 / 危机 / 性 / 宗教 / 政治 / 财务 / 家庭）与哈希脱敏 |
| `src/kernel/social/module.ts` | `SocialCognition`、`DisabledSocialCognition`、`createSocialCognition`、状态加载校验 |

默认参数：明说 0.6 / 行为 0.35 / 语气 0.2，单次上限 0.8；active 规则按可靠度把权重乘 0.5–1.5；
低于 0.15 关闭；会话间隔 2 小时；规则 3 次命中且命中率 ≥ 0.6 转 active，6 次试验命中率 < 0.4 停用。
规则的命中 / 失误来自两处：expectation 的预测对照（只计当前这次预测背后的规则），以及规则引出的假设被对方明确确认 / 否认。

Codex 审查（2026-11-21）后补的约束，均有回归测试（`tests/social-review.test.ts`）：

- 敏感词表在截断前检查全文，加载时再查一遍；
- 同一次调用里后来才被标为敏感的假设，本次返回的审计记录一并脱敏，同主张的已关闭记录和引出它的线索规则一起删除。**已经交出去的审计记录无法收回**，抽取器应在第一次就打标；
- 会话间隔在读取（`view`）和晋升时同样生效；宿主复用同一个会话 id 跨过间隔，算作新会话；
- 同一观察（ref）重复提交不叠加置信度；`promotable(about, now)` 排除已衰减的推测；
- 加载时 id 计数取已有 id 的最大值，避免跨人 id 碰撞；人员 id 拒绝 `__proto__` 等原型键。

## 8. 已定（2026-11-21）

1. 抽取以 LLM 为主；规则由 bot 提议更新，作为对象情绪权重记忆与参考（§2.1）。
2. QQ 群聊多对象建模进 T1。
3. 排入 M1。
4. 先作为可插拔社交认知模块验证（保障 T3 对照与回滚）；关系经历反向塑造 Self 留到下一阶段。
5. 行动原则：优先回应当下的社交意图；没有必要就不解释、不确认、不汇报（§3）。
