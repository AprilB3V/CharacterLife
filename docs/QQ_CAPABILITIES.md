# QQ 官方机器人能力核查（V0.2）

> 核查日期：**2026-10-19**
> 核查方式：读取官方仓库 README 与官方文档站点；**没有** AppID / AppSecret，因此
> **账号级权限一律未验证**。本文严格区分「文档口径」「SDK 可见能力」「本项目已实现」。

## 1. 信息来源

| 来源 | 用途 | 地址 |
|---|---|---|
| 官方 Node SDK README | 传输方式、事件、发送能力、中间件 | https://github.com/tencent-connect/qqbot-nodejs |
| 官方文档仓库 | 文档站点结构、更新入口 | https://github.com/tencent-connect/bot-docs |
| 文档站点 · 启动接入 | AppID/AppSecret、场景、SDK 列表 | https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/getting-started.html |
| 文档站点 · 消息收发概述 | 被动/主动消息、频控、去重、撤回 | https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html |

文档站点当时标注「上次更新：2026/07/21」。SDK README 当时版本未在文中给出具体号，只给出使用说明。

## 2. 账号与凭证

| 项 | 文档口径 | 本项目验证情况 |
|---|---|---|
| 凭证 | 注册后获得 `AppID` + `AppSecret` | ❌ 环境里没有，未验证 |
| 鉴权 | 用 AppSecret 换 `Access Token`，请求头 `QQBot <token>`；`Token` 方式已废弃 | ✅ 客户端实现，未真实调用 |
| 主体差异 | 个人认证 / 企业认证 / 未认证 影响主动消息频控 | ❌ 未验证（账号维度，无法离线确认） |
| 审核 | 需要创建机器人、配置权限、审核通过 | ❌ 未验证 |

> 结论：**本文不能回答「你的账号能用哪些场景」**。那取决于开放平台后台的权限勾选与审核结果。

## 3. 场景与事件（文档口径）

| 场景 | 接收事件 | 发送接口 | 本适配器 |
|---|---|---|---|
| QQ 单聊（消息列表） | `C2C_MESSAGE_CREATE` | `POST /v2/users/{openid}/messages` | ✅ 已实现 |
| QQ 群聊 @机器人 | `GROUP_AT_MESSAGE_CREATE` | `POST /v2/groups/{group_openid}/messages` | ✅ 已实现 |
| 群聊普通消息（未 @） | `GROUP_MESSAGE_CREATE` | 同上 | ⚠️ 事件未接（当前只处理 @ 机器人的消息） |
| 频道 | 频道消息事件 | `POST /channels/{channel_id}/messages` | ⚠️ 协议已实现，**但见 §6 的 WebSocket 限制** |
| 频道私信 | `DIRECT_MESSAGE_CREATE` | 同频道接口（私信路由） | ⚠️ 协议已实现，同受限 |

## 4. 被动回复（回复用户）

| 场景 | 有效期 | 每条消息可回复次数 |
|---|---|---|
| 单聊 | **60 分钟** | **4 次** |
| 群聊 | **5 分钟** | **5 次** |
| 频道 | 5 分钟 | 未声明上限 |
| 频道私信 | 5 分钟 | 未声明上限 |

实现：`QQAdapter` 按场景分别执行窗口与次数限制（`QQ_SCENE_LIMITS`），超限不报错，
而是把消息转入 CharacterLife 的待发送队列（`queued: true` + `WINDOW_EXPIRED` / `RATE_LIMITED`）。

## 5. 主动消息（角色主动联系）

| 项 | 文档口径 |
|---|---|
| 用户开关 | 用户可在客户端关闭「允许主动发送」，**关闭后主动消息一律失败** |
| 单聊频控 | 认证账号 10 qps；未认证 5 qps & 30 qpm；单关系 20 qpm；每日上限 1000 条/用户 |
| 群聊频控 | 认证 60 qpm；未认证 30 qpm；单关系 20 qpm；每日上限 1000 条/群 |
| 频道 | 默认 20 条/子频道/天，每天最多 2 个子频道；同频道 5 条/秒；**发送需机器人 WebSocket 在线** |
| 频道私信 | 每机器人每天对每用户 2 条；每天累计 200 条 |
| 互动召回 | `is_wakeup=true`：用户主动对话后 30 天内 4 个周期，每周期 1 条 |

本项目的策略（`docs/ADAPTER_PROTOCOL.md` 有完整说明）：

1. 适配器默认 **`proactive: false`** —— 不声明能力，就不发送；
2. 角色产生的主动消息保留在 `workspace` 待发送队列；
3. 用户下次来信时，未发出的消息**作为「资料」并入本轮**（不是伪装成被动回复）；
4. 只有显式配置 `QQBOT_PROACTIVE=true` 且账号确实有额度时才主动推送。

## 6. 传输方式：Webhook vs WebSocket

| 方式 | SDK 支持 | 本项目 |
|---|---|---|
| Webhook | ✅（含 Ed25519 签名校验、内置 node:http 适配） | ✅ 已实现 `examples/qq-bot/server.ts` |
| WebSocket | ✅（长连接 + 心跳 + RESUME） | ❌ 未实现（需要官方 SDK 或自研 WS 网关，违反零依赖原则） |

**重要限制**：文档在「文字子频道」一节写明「发送消息接口要求机器人接口需要连接到 WebSocket 上保持在线」。
也就是说：

- 单聊 / 群聊的 HTTP 发送不依赖 WebSocket（本项目可用）；
- **频道的消息发送依赖 WebSocket 在线** → 纯 Webhook 模式无法完整支持频道场景。

这一点**没有在真实账号上验证**，但文档表述明确，因此本项目的 `docs/QQ_SETUP.md`
把频道场景标注为「需要额外接入官方 SDK 的 WS 传输」。

## 7. 消息去重与多次回复

文档口径：

- 相同 `msg_id` 可能被多次推送 → 需要去重；
- 被动回复时相同 `msg_id + msg_seq` 重复发送会失败 → 多次回复要递增 `msg_seq`。

本项目实现：

- **入站去重**：`processed_messages(platform, platform_message_id)` 主键 + 网关幂等，
  重复事件直接返回 `duplicate`，不重复调用模型（见 `tests/adapters/qq.test.ts`）；
- **出站 msg_seq**：适配器按入站消息计数递增 `msg_seq`，并在达到场景上限时停止。

## 8. SDK 能力 vs 本项目实现

| SDK/文档能力 | 本项目 | 说明 |
|---|---|---|
| 双传输（WS/Webhook） | 仅 Webhook | 零依赖取舍，见 §6 |
| `message` 事件覆盖 C2C/群/频道/私信 | ✅ 四个事件都解析 | `src/adapters/qq/events.ts` |
| 文本 / Markdown / 富媒体 | 仅文本 | V0.2 范围 |
| C2C 流式消息 | ❌ | 需要 SDK 的 stream 控制器；本项目走普通文本 |
| 内置中间件（去重/限流/白名单） | 自研等价能力 | 去重表 + 网关限流 + 身份绑定 |
| 媒体上传（分片/整文件） | ❌ | 未实现 |

## 9. 明确「未验证」清单

1. 本账号能否收到 `C2C_MESSAGE_CREATE`（需要真实 AppID + 已添加机器人 + 审核）。
2. Webhook 的 Ed25519 公钥派生算法是否与平台一致（本项目按社区做法实现，只用自签自验测试过）。
3. 回调地址的公网可达性、IP 白名单、超时重试策略的实际表现。
4. 主动消息的实际额度与用户开关表现。
5. 个人开发者与企业在 QQ 群 / 单聊场景的可见差异（后台权限项，无法离线核实）。

## 10. 结论

- **能离线确认的部分**（协议、事件字段、被动回复窗口、频控、去重语义）已经全部写进代码与测试；
- **不能确认的部分**（账号权限、审核、真实回调）一律标注为未验证，不用「SDK 有接口」代替「账号有权限」；
- 因此本项目的 QQ 适配器状态是：**协议完整 + 离线可复现 + 真实联调未执行**。
