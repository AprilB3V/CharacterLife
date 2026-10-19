# A/B 对照实验结果（Mock Provider）

| 组 | Provider | 轮数 | 人格是否被改 | 非法状态变更(采纳/拦截) | 最终关系 | 记忆可用事实 | 重启后恢复 | 主动消息 | prompt/completion tokens | 平均延迟(ms) | 平均上下文字符 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A | mock/mock-in-character | 8 | 否 | 0 / 0 | intimacy=0 | 2/2 | 否 | 0 | 2565/773 | 0.3 | 695 |
| B | mock/mock-in-character | 8 | 否 | 0 / 0 | 信任=4 熟悉=16 阶段=acquaintance | 2/2 | 是 | 1 | 8001/1144 | 0.1 | 2192 |
| A | mock/mock-compliant | 8 | 是 | 3 / 0 | intimacy=85 | 2/2 | 否 | 0 | 2332/201 | 0.0 | 632 |
| B | mock/mock-compliant | 8 | 否 | 0 / 5 | 信任=4 熟悉=16 阶段=acquaintance | 2/2 | 是 | 1 | 8495/1093 | 0.1 | 2326 |

> ⚠️ 本表由 **Mock Provider** 生成（离线、确定性、零费用），衡量的是**运行时架构**：
> 谁能写状态、记忆是否持久、权限是否生效。它 **不是** DeepSeek 真实模型的实测结果，
> 不含任何真实 API 调用或费用。真实模型实验见 reports/REAL_MODEL_RUN.md（已执行 18 次调用）。
>
> 延迟列在 Mock 下没有参考意义（内存内同步返回，多次运行抖动 0.0–0.3 ms）；
> token 列是按字符量估算的，不是真实计费。
