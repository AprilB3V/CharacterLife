# V0.2 测试报告：跨平台适配与统一角色接口

> 报告只记录**实际执行**结果。三层验证严格分开：Mock 协议测试 / 真实模型 API / 真实客户端联调。
> 所有数字来自本机运行，命令可复现。

## 1. 环境

| 项 | 值 |
|---|---|
| DSH | 0.2.0-rc.2 |
| 会话模型 | `deepseek-v4-flash`（Harness 自述） |
| 引擎调用模型 | 未在 V0.2 新增真实调用；V0.1.1 实测请求 `deepseek-chat` → 服务端 `deepseek-flash` |
| Node.js | v26.7.0 |
| 操作系统 | Windows 11（NT 10.0.26200，25H2，x64） |
| 数据库 | SQLite（`node:sqlite` 3.53.4），schema v2 |
| 角色模板 | 沈知微（V0.1 原创角色，未改动） |
| SillyTavern | **1.17.0**（`C:\Git\SillyTavern-1.17.0`，本机真实安装） |
| QQ 凭证 | **无**（未申请/未放入），因此没有任何真实 QQ 联调 |

## 2. 测试总量

```
npm test  →  147 passed / 0 failed（47 suites）
npm run typecheck → 无输出
```

| 测试文件 | 用例 | 覆盖 |
|---|---|---|
| 原有 V0.1/V0.1.1 | 110 | 四模块、人格、安全、持久化、跨会话 |
| `tests/adapters/qq.test.ts` | 17 | 事件解析、身份映射、去重、非法输入、权限降级、持久化、人格保护、Mock 无凭证、签名校验 |
| `tests/adapters/sillytavern.test.ts` | 8 | 模型列表、chat completions、流式 SSE、人格保持、新会话记忆、大历史、重启继续、越权读取 |
| `tests/cross-platform/continuity.test.ts` | 6 | QQ 约定 → 绑定码 → 酒馆复述、重启后绑定有效、第三方读不到、双平台并发、一次性码、猜码无效 |
| `tests/cross-platform/binding-codes.test.ts` | 6 | 正常消费、过期、一次性、尝试次数、改绑拒绝、只存哈希 |

回归：V0.1/V0.1.1 的 110 个用例**全部仍然通过**，持久化数据库自动从 schema v1 迁移到 v2（纯新增表）。

## 3. 三层验证（不要混为一谈）

| 层次 | 做了什么 | 结果 | 不能说明什么 |
|---|---|---|---|
| **A. Mock 协议测试** | 用官方事件格式 + `MockTransport` 跑完整链路（解析→身份→引擎→发送） | ✅ 37 个新用例全绿 | 不能说明真实 QQ 账号有权限 |
| **B. 真实模型 API** | V0.1.1 已执行 18 次 DeepSeek 调用（本轮**未新增**调用） | ✅ 见 `reports/REAL_MODEL_RUN.md` | 不能说明 QQ 平台侧行为 |
| **C. 真实客户端联调** | 启动真实 **SillyTavern 1.17.0**，经它的 `/api/backends/chat-completions/generate`（`chat_completion_source: custom`）调用 CharacterLife | ✅ HTTP 200，返回标准 `chat.completion`，usage 811/133 | **不是浏览器 UI 联调**；前端渲染/流式解析未覆盖 |
| **D. 真实 QQ 联调** | — | ❌ **未执行**（无 AppID/AppSecret、无审核通过的机器人） | 不能声称 QQ 已打通 |

### 3.1 C 层证据（真实酒馆服务端 → CharacterLife）

```
✅ SillyTavern 就绪：pkgVersion=1.17.0
通过酒馆 /api/backends/chat-completions/generate 转发请求…
  HTTP 200
  {"id":"chatcmpl-...","object":"chat.completion",
   "choices":[{"index":0,"message":{"role":"assistant","content":"被水泡过的先别晒。……"},"finish_reason":"stop"}],
   "usage":{"prompt_tokens":811,"completion_tokens":133,"total_tokens":944}}
✅ 酒馆服务端 → CharacterLife 转发成功（这是真实酒馆代码路径，不是裸 HTTP 测试）
```

复现：`node experiments/real-clients/sillytavern-smoke.ts`
（探针为免浏览器会话加了 `--disableCsrf`，仅本机使用）

### 3.2 未执行项与原因

| 项 | 原因 |
|---|---|
| QQ 真实收发 | 没有 AppID/AppSecret；申请与审核需要账号主体操作，不属于本次授权 |
| QQ Webhook 真实回调验签 | 同上（Ed25519 派生只用自签自验测试过） |
| 频道场景 | 官方文档要求机器人 **WebSocket 在线**才能发频道消息；本项目零依赖、只实现 Webhook |
| 酒馆浏览器 UI | 本环境无可用浏览器自动化，只验证到「酒馆服务端构造请求 + 解析响应」 |
| 多用户酒馆 | 默认单用户；多用户需先跑绑定流程，且没有账号体系 |

## 4. 本轮真实错误与修复（8 条）

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | `server.ts` 中文全变乱码 | 用 PowerShell `Set-Content -Encoding utf8` 重写文件（PS 5.1 编码行为） | 改用 write/edit 工具整份重写；此后不再用 shell 改源码 |
| 2 | 酒馆返回 `403 Invalid CSRF token` | CSRF token 绑定浏览器会话 cookie，脚本拿不到 | 探针加 `--disableCsrf`（仅本机）；文档标注生产勿关 |
| 3 | 新建平台实例后「她没有生活事件」 | `IdentityService` 只建实例行，没写初始状态与模板时间线 | 建实例时写入初始状态 + 全套模板事件；QQ demo 现在能触发 7 个事件 |
| 4 | 被动回复窗口统一写成 5 分钟 / 4 次 | 与官方文档不符（单聊 60 分钟/4 次、群聊 5 分钟/5 次） | 改为 `QQ_SCENE_LIMITS` 按场景限制 |
| 5 | 群聊 @ 清洗测试失败（`@机器人` 没被去掉） | 测试用了字面 `@机器人`，而平台实际是 `<@!id>` 标记 | 测试改用真实标记格式 |
| 6 | OpenAI 兼容层 `usage` 恒为 0 | `InboundOutcome` 没有透传 token 用量 | Gateway 增加 `usage` 字段，服务端透传 |
| 7 | 酒馆探针误判「未就绪」 | 首次启动要编译前端（webpack ~28 秒） | 就绪轮询延长到 120 秒 |
| 8 | 整套测试偶发 `fetch failed` | undici keep-alive 复用了上一条测试已关闭的连接 | HTTP 测试请求加 `Connection: close` |

## 5. 与任务书验收项的对应

### A. QQ（八-A）

| 要求 | 结果 | 证据 |
|---|---|---|
| 官方事件解析正确 | ✅ | `QQ · 事件解析`（4 场景字段） |
| 用户身份映射正确 | ✅ | 同一 openid 复用实例；不同 openid 不同实例 |
| 重复消息不重复处理 | ✅ | `重复消息只处理一次（幂等）` |
| 无效输入安全处理 | ✅ | `非法事件不会把机器人打挂` |
| 超时/限流/权限不足降级 | ✅ | 403 → `delivery_failed`；429 不重试；窗口过期/条数上限 → `queued` |
| 状态变更持久化 | ✅ | 关库重开关系一致 |
| 核心人格不可被覆盖 | ✅ | 注入文本后 traits 逐字不变，审计有 `injection_detected` |
| Mock 测试不需要真实凭证 | ✅ | 全程 `MockTransport`，无网络 |

### B. SillyTavern（八-B）

| 要求 | 结果 |
|---|---|
| 模型列表 | ✅ |
| Chat Completions 兼容 | ✅（含 SSE 流式、`[DONE]` 结束） |
| 通过酒馆实际发送 | ⚠️ 服务端转发成功；**UI 未测** |
| 人格由 CharacterLife 保持 | ✅（system 卡不改人格） |
| 新会话恢复长期记忆 | ✅ |
| 大量历史不失控 | ✅（12 轮 × 40 条超长历史） |
| 重启后继续 | ✅ |

### C. 跨平台（八-C）

| 要求 | 结果 |
|---|---|
| QQ 约定 → 酒馆复述 | ✅（同一实例、关系一致） |
| 关系状态一致 | ✅（trust/familiarity 相等） |
| 共同经历不重复写入 | ✅（绑定时记忆条数只 +0..2） |
| 重启后仍正确 | ✅ |
| 未绑定用户读不到 | ✅（400 `IDENTITY_NOT_BOUND`） |

## 6. 仍未完成

1. **QQ 真实联调**（最大缺口）：没有凭证，协议层做完、平台层没验。
2. **酒馆 UI 级联调**：只到服务端转发层。
3. 主动消息调度器：消息只进队列，靠用户下一条消息带走，没有定时推送。
4. 富媒体（图片/语音）、Markdown、`GROUP_MESSAGE_CREATE`（群内未 @ 的消息）。
5. 多进程部署（进程内锁 + SQLite 单写者）。
6. 真实模型下的跨平台人格一致性（本轮未新增真实调用）。

## 7. 结论

- 适配层做到了「平台 SDK 不侵入引擎、平台拿不到数据库、外部输入一律不可信」；
- 跨平台「同一角色、两个入口、一份记忆」在 Mock + 真实酒馆服务端两层都跑通了；
- **QQ 侧只能算协议完成，不能算已接入**——没有凭证就没有真实联调，报告里如实标注。
