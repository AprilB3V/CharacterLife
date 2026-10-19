# 本次 DeepSeek 工程表现与局限

> 这份文档回答两个问题：**这次开发用的是什么 DeepSeek 环境**，以及
> **DeepSeek 模型在这次真实工程任务里表现如何、哪里不行**。
> 凡是不能核实的，都标成「未核实」，不编造版本号或跑分。

---

## 1. 可核实的运行环境

| 项 | 值 | 核实方式 |
|---|---|---|
| DSH 版本 | **0.2.0-rc.2** | `dsh --version` 与 `@deepseek-ai/dsh` 的 `package.json` 一致 |
| DSH 安装路径 | `C:\Users\86509\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh` | 文件系统 |
| 会话运行模型 | **`deepseek-v4-flash`** | DSH 运行时上下文自述（`You are powered by the deepseek-v4-flash model`） |
| 接口形态 | DeepSeek Harness Web GUI（`http://127.0.0.1:3080`） | 运行时上下文 |
| 操作系统 | Windows 11（NT 10.0.26200，25H2，x64） | `[Environment]::OSVersion` |
| Node.js | v26.7.0 | `node -v` |

**无法核实、因此不做任何断言的部分：**

- 具体权重版本、训练数据截止时间、上下文窗口大小、是否 MoE —— 运行时均不暴露。
- 输出 token 上限、并发限制、计费单价 —— 未调用真实 API，无法从响应头或账单核实。
- `deepseek-v4-flash` 与公开 API 上 `deepseek-chat` / `deepseek-reasoner` 的对应关系 —— **未知**，
  两者不能互相等同。

## 2. 引擎侧配置的 API 路由（未验证）

`src/conversation/providers/deepseek.ts` 按官方文档实现，但**本次交付没有执行过任何真实调用**：

| 项 | 配置值 | 状态 |
|---|---|---|
| 端点 | `POST https://api.deepseek.com/chat/completions` | 未验证 |
| 鉴权 | `Authorization: Bearer ${DEEPSEEK_API_KEY}`（只读环境变量） | 未验证 |
| 默认模型 | `deepseek-chat`（可用 `DEEPSEEK_MODEL` 覆盖） | 未验证 |
| 结构化输出 | `response_format: { type: "json_object" }` | 未验证 |

因此 README 里**没有**写「支持 DeepSeek 实测通过」，只写「按官方文档配置」。

## 3. 真实模型实验：未执行

### 3.1 原因

1. 本次会话环境里**没有** `DEEPSEEK_API_KEY`。DSH 的凭据文件
   （`~/.dsh/.credentials.yaml`）里存在对这个名字的**引用**，但真实值不在我的进程环境里，
   脚本读不到；我也没有去尝试读取或解密凭据。
2. 我把这个决策点交给用户：是否用 6 次调用（2 组 × 3 轮）做一次真实对照。
   **用户选择「跳过，报告明确标注未执行」。**

### 3.2 影响（必须承认的）

- `reports/` 里所有对话样例都来自 `MockProvider`，**不是 DeepSeek 输出**。
- A/B 表里的 token/延迟是**字符规模估算**，不是真实计费与真实响应时间。
- 「人格一致性」「记忆准确性」「回复自然度」在真实模型下**未知**。
- 因此本项目的结论只能限定为：**运行时架构与权限层有效**，不能声称「DeepSeek 扮演得更好」。

### 3.3 已设计好、可直接执行的实验（待授权）

```powershell
# 1) 配置（只在当前 shell 生效，不写入仓库）
$env:DEEPSEEK_API_KEY = "sk-..."      # 需用户自己放入
$env:DEEPSEEK_MODEL   = "deepseek-chat"

# 2) 小样本冒烟（1 次调用）
node -e "import('./src/index.ts').then(async m=>{const p=new m.DeepSeekProvider({apiKey:process.env.DEEPSEEK_API_KEY});const r=await p.complete({system:'只输出 JSON：{\"reply\":\"你好\"}',messages:[{role:'user',content:'测试'}],temperature:0,maxTokens:64,jsonMode:true});console.log(r.model,r.usage)})"

# 3) A/B 对照（脚本内预设 2 组 × 3 轮 = 6 次调用，远低于 20 次上限）
#    需要先把 experiments/ab/run.ts 的 --real 分支接到 DeepSeekProvider
node experiments/ab/run.ts --real
```

预算控制：脚本硬性限制为 `2 × 3 = 6` 次调用；每次 `maxTokens=800`。实际费用以官方计价为准，
**本仓库不提供价格估算**，因为无法核实当前单价。

评价方法（自动部分与主观部分分开）：

| 指标 | 采集方式 | 自动/主观 |
|---|---|---|
| 人格一致性 | 比对最终 `traits` 与原始设定；统计被拒绝的越权提议 | 自动 |
| 非法状态变更率 | 被采纳的 `profile`/`relationship` 变更 / 总轮次 | 自动 |
| 记忆准确性 | 3 个探针问题，人工核对回复是否包含事实、是否篡改 | 半自动 |
| 主动行为合理性 | 触发时机、内容是否越界、是否在静默期内 | 自动 + 人工 |
| 回复自然度 | 1–5 分人工评分（A/B 盲评，顺序随机） | **主观** |
| token 与延迟 | `usage` 与 `latencyMs` 原样记录 | 自动 |

## 4. 本次 DeepSeek 的工程表现（自我评价）

评价对象是「在这次任务里，DeepSeek 驱动的这个 Agent 实际做成了什么、怎么失败的」。

### 4.1 做成的

- **真实执行，而不是只给方案**：从权限修复、建工程、写四模块、跑演示、写到 78 个测试并全部跑通，
  全部在本会话内实际完成；日志与快照都是真实产物。
- **用测试抓到了自己的 14 个真实缺陷**：包括时间线去重写错、限速误伤里程碑、
  意图正则漏判、A/B 实验首版结论无效。修复过程记录在 `reports/TEST_REPORT.md §4`。
- **在受限环境里找到可行路径**：Windows 沙箱禁止测试运行器 spawn 子进程，
  改用 `--test-isolation=none`；npm 缓存默认在受限目录，改到仓库内 `.npm-cache`。
- **区分了「实测」与「未测」**：没有把 Mock 输出说成 DeepSeek 结果，也没有编造模型版本。
- **架构可落地**：零运行时依赖、无需构建、四模块接口清晰、状态与权限解耦。

### 4.2 做得不好的（真实返工）

| 问题 | 表现 | 返工成本 |
|---|---|---|
| 首版 A/B 实验**结论是错的** | Mock 只产出 CharacterLife 的信封格式，传统角色卡拿不到 `state`，于是「A 组人格未被改」的结论完全无效 | 需要重新设计契约协商，重跑 |
| 启发式规则想当然 | 「放弃你的爱好吧」「把你的性格改掉」「你是不是一个 AI 程序」全部漏判，都是测试跑红后才发现 | 3 轮正则返工 |
| 演示时间标签算错 | 用 `4*DAY` 表示「Day4」，实际是 Day5（`sim=0` 是 Day1），输出与标题不一致 | 重新计算所有时间点 |
| 早期没估 token 预算 | 直到写 DECISIONS 统计时才发现 B 组 prompt token 是 A 组的 3.1 倍 | 无法消除，只能记录并给上限参数 |
| ESM 里用了 `require` | demo 的 `exists()` 直接写错，运行时报错才发现 | 小 |
| 一次「删掉死代码」的判断 | 先写了 `#chatDeltaCap` 却发现聊天层根本没有关系写权限，规则永远不可达，只能删掉 | 小 |

### 4.3 无法自证的

- **语言质量**：Mock 台词是我手写的模板，不能代表模型的人格说服力；
  真实模型会不会「说着说着就顺从了」，本仓库没有证据。
- **成本意识**：只统计了字符与估算 token，没有真实账单。
- **绝对防越狱**：不可能，也没有声称。

## 5. 结论

这次要测的不是「模型会不会写代码」，而是「**能不能在真实约束下把研究性设计落成可运行、
可测试、可复现的工程**」。就这一点，本次结果是正向的：四模块能跑、78 个测试全绿、
三个剧情事件可重放、重启能恢复、越权在模型完全被说服的情况下仍然拦得住。

同时必须保留的负面事实：**真实模型实验完全没做**；启发式分类器很脆；
首版对照实验是错的；上下文（聊天记录）不持久化。
这些都在 `README.md`、`docs/DECISIONS.md`、`reports/TEST_REPORT.md` 中如实标注，
不做宣传性修饰。
