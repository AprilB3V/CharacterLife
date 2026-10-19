# V0.2 B 站视频素材说明（跨平台适配）

> 素材全部来自真实运行，命令可复现。凡是没做的（QQ 真实联调、酒馆 UI），
> 下面都明确标了「没做」，不要用模拟冒充。

## 0. 一句话主张

> 「同一个角色，在 QQ 和酒馆里是**同一个人**：人格、关系、记忆、时间线都在 CharacterLife，
> 平台只是入口。」

## 1. 素材清单

| 素材 | 路径 / 命令 | 说明 |
|---|---|---|
| QQ 离线全链路演示 | `node examples/qq-bot/demo.ts` | 事件→身份→引擎→发送，含指令与待发送队列 |
| 酒馆协议演示 | `node examples/sillytavern/demo.ts` | 模型列表、chat completions、新会话、记忆、SSE |
| **真实酒馆服务端联调** | `node experiments/real-clients/sillytavern-smoke.ts` | 启动 SillyTavern 1.17.0，经它的 generate 路由调 CharacterLife |
| 跨平台测试 | `npm test`（147 项） | 其中 37 项是 V0.2 新增 |
| 能力核查 | `docs/QQ_CAPABILITIES.md` | 文档口径 + 未验证清单 |
| 适配器协议 | `docs/ADAPTER_PROTOCOL.md` | 给新平台写适配器的 7 步 |
| OpenAPI | `docs/openapi.yaml` | 可直接导入 Postman/Swagger |

## 2. 五个必拍素材点

### ① QQ 机器人接入过程

**画面**：`examples/qq-bot/demo.ts` 的前两段输出。

```
━━━ 1. 首次接触：自动创建角色实例 ━━━
  状态：replied
  实例：inst_001
  实际请求：POST https://bots.qq.com/app/getAppAccessToken , POST https://api.sgroup.qq.com/v2/users/openid_demo_user/messages
```

**口播要点**：
- 演示用的是**官方事件格式**（`C2C_MESSAGE_CREATE`）和**官方发送接口**，只是把网络层换成了 Mock；
- 真实凭证一旦拿到，换 `FetchTransport` 就是真实链路（`examples/qq-bot/server.ts` 已经写好）；
- **必须说明**：本片没有真实 QQ 账号联调，因为没有 AppID/AppSecret；
  协议层与限制（单聊 60 分钟/4 次、群 5 分钟/5 次）来自官方文档，已写进代码。

### ② 角色收到 QQ 消息后的内部处理流程

**画面**：`docs/ADAPTER_PROTOCOL.md` §1 的数据流图 + 终端里的日志。

**口播要点**（逐层点名）：
1. `parseInbound`：只做协议翻译，`trust: 'untrusted'`；
2. 去重表：相同 `msg_id` 第二次直接 `duplicate`；
3. 身份：`openid → 角色实例`，首次接触自动建实例；
4. 每实例一把锁：QQ 与酒馆同时说话也不会互相覆盖；
5. 指令 `/status` 不走模型；
6. 待发送的主动消息作为**资料**并入下一轮（不伪装成被动回复）；
7. 发送失败 → 结构化错误 → 入队，不抛异常。

**可现场演示**：同一条消息发两次，第二次输出 `duplicate`。

### ③ 跨会话人格与记忆恢复演示

**画面**：`node examples/persistent-demo.ts init/chat/resume/verify`（V0.1.1 道具，仍然有效）。

**口播要点**：新进程 + 新会话，8 步恢复报告，能复述「被水泡的《陶庵梦忆》」和「明天下午的约定」。

### ④ QQ 与酒馆共享同一角色实例

**画面**：`tests/cross-platform/continuity.test.ts` 的运行输出，或现场脚本：

```
QQ  /bind           → 绑定码：65588919（5 分钟、一次性、最多 3 次）
酒馆 POST /v1/identity/redeem {code} → 同一实例 inst_001
酒馆问「我们之前说好的事还记得吗？」→ 关系与 QQ 侧完全一致
```

**口播要点**：
- 绑定码只存哈希、一次性、过期、限次；
- **知道 instanceId 不等于有权限**（测试里猜码绑定失败）；
- 未绑定的第三方读不到别人实例（400 `IDENTITY_NOT_BOUND`）。

### ⑤ 失败案例、调试记录与限制

**画面**：`reports/V02_TEST_REPORT.md` §4 的 8 条真实错误表。

重点讲三条：

1. **酒馆 403 CSRF**：token 绑定浏览器会话，脚本拿不到 → 探针加 `--disableCsrf`（生产不能关）；
2. **新建角色没有生活事件**：接入层建实例时漏了「写初始时间线」，导致她不会自己过日子 → 修复后 QQ demo 能触发 7 个事件；
3. **被动回复窗口写错**：最初统一写成 5 分钟，查官方文档才发现单聊是 60 分钟 → 改成按场景限制。

**必须说清楚的三条边界**：
- QQ 没有真实联调（无凭证）；
- 酒馆只到服务端转发层，UI 没测；
- 频道场景需要 WebSocket 常连，本项目只做 Webhook。

## 3. 拍摄建议

1. 先拍 `npm test`（147 项，8 秒内跑完），再拍两个 demo，最后拍酒馆真实转发（要等 30–60 秒编译，建议加速）。
2. 终端字号 ≥16，宽 ≥120 列（数据流图不用折行）。
3. 跑酒馆探针前先确认 8799 端口空闲；结束后 `.st-data` 可以删除（已在 .gitignore）。
4. 可以现场演示「同一句话发两次 → duplicate」「`/bind` → 码 → 酒馆绑定」这两段，节奏最好。

## 4. 红线

- 不要说「QQ 已经接入成功」——**没有真实凭证，没有真实联调**。
- 不要说「酒馆 UI 兼容」——只验证了服务端转发与 SSE 协议。
- 不要展示任何 `AppSecret`、API Token、真实 openid 或聊天正文截图。
- 不要把 `queued: true`（主动消息降级）说成 bug —— 那是平台限制下的正确行为。
