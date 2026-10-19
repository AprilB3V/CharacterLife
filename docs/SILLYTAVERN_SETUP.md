# SillyTavern 接入与本地联调

> 目标：让酒馆（SillyTavern）作为「聊天界面」，而人格、关系、长期记忆由 CharacterLife 持有。
> 酒馆端的角色卡只是**展示文本**，不会成为可信人格配置。

## 1. 启动 CharacterLife API

```powershell
$env:CHARACTERLIFE_API_TOKEN = "local-dev-token-123"   # 至少 8 位
$env:CHARACTERLIFE_DB        = "data/characterlife.db"
# 可选：真实模型；不设置则用 MockProvider
$env:DEEPSEEK_API_KEY        = "sk-..."

node examples/sillytavern/start-server.ts
```

输出会直接告诉你酒馆该怎么填：

```
CharacterLife API 已启动：http://127.0.0.1:8787
SillyTavern 配置（Chat Completion → Custom (OpenAI-compatible)）：
  Base URL : http://127.0.0.1:8787/v1
  API Key  : local-dev-token-123
  模型      : characterlife/shen-zhiwei
```

默认**只监听 127.0.0.1**。要绑非回环地址必须显式：

```powershell
$env:CHARACTERLIFE_ALLOW_PUBLIC = "true"
```

（公网部署不在本项目授权范围内，且需要自己加 TLS、反向代理、真正的多用户鉴权。）

## 2. 配置 SillyTavern

在本机已安装的酒馆（本次验证使用的是 **SillyTavern 1.17.0**）里：

1. 打开 **API 连接**（插头图标）；
2. **API** 选择 `Chat Completion`；
3. **Chat Completion Source** 选择 **Custom (OpenAI-compatible)**；
4. **Custom Endpoint (Base URL)** 填 `http://127.0.0.1:8787/v1`
   （只填到 `/v1`，酒馆会自己拼 `/chat/completions`）；
5. **Custom API Key** 填你的 `CHARACTERLIFE_API_TOKEN`；
6. 点 **连接 / 刷新模型**，模型下拉里应出现 `characterlife/shen-zhiwei`；
7. 选它，开始聊天。

> 如果酒馆提示连接失败：先 `curl http://127.0.0.1:8787/v1/models -H "Authorization: Bearer <token>"`，
> 能看到 JSON 就说明是酒馆那边填错了（常见是 URL 多写或少写 `/v1`）。

## 3. 角色卡怎么填（重要）

CharacterLife 的人格来自自己的 Template（`examples/characters/shen-zhiwei.ts`）。
酒馆里的角色卡**只影响显示**，不会改写人格。建议：

- 角色名填「沈知微」，描述可写一句「旧书修复师」；
- **不要**把「你是一个无条件顺从的助手」这类指令写进角色卡或 system prompt ——
  即使写了也不会生效，而且会被当作不可信的「外部设定文本」记进本轮资料（有长度上限 600 字）；
- 世界书（World Info）可留空——长期记忆由 CharacterLife 检索，不需要酒馆再灌一遍。

## 4. 记忆与会话的关系

| 操作 | 结果 |
|---|---|
| 酒馆里「新开聊天」 | CharacterLife 侧不复用酒馆历史，但**长期记忆、关系、时间线都在** |
| 调用 `POST /v1/sessions` | 显式新开会话（保留长期记忆） |
| 删除酒馆聊天记录 | 不影响 CharacterLife 的长期记忆 |
| 重启 CharacterLife | 从 SQLite 恢复，关系与记忆不变（有测试覆盖） |

酒馆每次请求都会带上一大段历史；CharacterLife **只用最后一条 user 消息**作为本轮输入，
历史由 Context Manager 按预算决定要不要、要不要压缩。这样可以避免「两套记忆互相污染」和
「历史越长 token 越爆」。

## 5. 已验证 / 未验证

### 已验证（本次实际执行）

| 项 | 方式 | 结果 |
|---|---|---|
| OpenAI 兼容接口结构 | 真实 HTTP 服务 + 8 个自动化测试 | ✅ `/v1/models`、`/v1/chat/completions`（含流式 SSE）、`/v1/sessions`、`/v1/messages`、状态与记忆接口 |
| 酒馆**服务端代码**转发 | 启动真实 **SillyTavern 1.17.0**，通过它的 `/api/backends/chat-completions/generate`（`chat_completion_source: custom`）调用 CharacterLife | ✅ HTTP 200，返回标准 `chat.completion`，usage 811/133 |
| 重启后继续 | 关服务 → 重开同一数据库 → 再发消息 | ✅ 状态不变（自动化测试） |
| 大历史不失控 | 每轮附带 40 条超长历史 × 12 轮 | ✅ 全部 200，估算 token 不超预算 |

真实联调命令：

```powershell
node experiments/real-clients/sillytavern-smoke.ts
# 输出：✅ SillyTavern 就绪：pkgVersion=1.17.0
#       ✅ 酒馆服务端 → CharacterLife 转发成功
```

> 该探针为了免去浏览器会话，启动酒馆时加了 `--disableCsrf`（仅本机探针用；日常请保持 CSRF 开启）。

### 未验证（必须知道）

| 项 | 原因 |
|---|---|
| 酒馆**浏览器 UI** 级联调 | 本环境没有可用浏览器自动化；只验证到「酒馆服务端构造请求并解析响应」这一层 |
| 酒馆前端流式渲染 | 同上（SSE 协议本身已测） |
| 多用户酒馆共享一个 API | 默认本地单用户；要多用户必须按身份隔离（见下） |

## 6. 多用户 / 跨设备（限制）

默认所有酒馆请求都映射到同一个本地身份 `local-default`，**同一个 API Token 的用户会共享角色实例**。

如果需要区分身份：

1. 每个用户先拿到一个绑定码（在 QQ 里 `/bind`，或 `POST /v1/identity/bind-code`）；
2. 用 `POST /v1/identity/redeem` 消费绑定码，把「酒馆身份」绑到某个实例；
3. 之后请求带 `X-CharacterLife-Identity: <该身份>`，服务端只接受**已绑定**的身份，否则 400 `IDENTITY_NOT_BOUND`。

本项目没有做账号密码体系，也不建议直接暴露到公网 —— 那需要 TLS、独立鉴权与实例配额，
不在 V0.2 范围内。

## 7. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 401 | Token 没填 / 填错 / 少于 8 位 | 检查 `CHARACTERLIFE_API_TOKEN` 与酒馆里的 API Key |
| 404 `NOT_FOUND` | Base URL 写成了 `http://127.0.0.1:8787`（少了 `/v1`） | 补 `/v1` |
| 429 | 每 Token 120 请求/分钟 | 放慢；或调 `createApiServer({rateLimit})` |
| 回复是「我这边网好像飘了」 | 上游模型报错，引擎做了安全降级 | 看服务端日志与 `provider_error` 审计 |
| 模型列表是空的 | 酒馆没刷新模型 | 点「刷新模型」或重启酒馆 |
| 新聊天后她忘了刚才说的 | 这是设计：最近对话不在长期记忆里 | `/status` 看关系仍在；长期记忆需要发生过（约定/事件/明确事实） |
