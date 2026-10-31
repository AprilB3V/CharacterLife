# 鲸鲸视频搭档（试验，尚未验收）

## 当前边界

使用独立 SQLite 数据库，绝不使用群聊数据库、绑定码或导入群聊记录。模板 `maibot@2` 是新的内容版本，毒舌措辞为占位，待主导者用脱敏样例确认。`checkTemplateVersion` 是校验器，不执行迁移；v1 实例不能直接加载 v2，严禁原地覆盖 v1。视频实例从空数据库新建，不迁移群聊实例。`verifyTemplate` 校验哈希；视频实例 ID 由身份服务生成，不保证为固定字符串。

**录制前阻塞：**当前 CL 可能在每轮立即持久化候选记忆，尚未实现录后审核通过才进入长期记忆。不要将试录数据库当成审核过的记仇本；需要先实现并验证审核流程，或者主导者明确决定采用其他处理方式。SSE 为完整生成后分块，首句延迟和打断效果不能根据流式协议推断。

## 启动（Windows cmd）

需要 Node 22.6 或更高版本。首次使用空的专用数据库，验证路径不属于其他实例。不要把密钥放进命令历史、仓库或日志。以下为环境变量名，密钥值请在本地安全设置；本程序只绑定回环地址。

```cmd
set CHARACTERLIFE_VIDEO_DB=data\jingjing-video\characterlife.db
set CHARACTERLIFE_API_TOKEN=<本地随机令牌，至少8位>
set CHARACTERLIFE_PORT=8787
node examples/video-cohost/start-server.ts
```

不设置 `DEEPSEEK_API_KEY` 时为 Mock，Mock 的固定回复含默认角色内容，只验证协议，不用于评价语气。要切真实模型，在本地设置该变量后重启；实际调用会产生费用。服务端不读取或修改 MaiBot。每次先核对数据库与身份，勿调用跨平台绑定接口。服务启动后用本机客户端携 Bearer token 请求 `/v1/models`，模型为 `characterlife/jingjing-video`；避免把完整请求和令牌写进终端记录。

## 语音外壳（尚未实测）

本地 Open-LLM-VTuber 的 `character_config` 中：`persona_prompt` 留空；`agent_config.conversation_agent_choice` 选 `basic_memory_agent`；其 `llm_provider` 选 `openai_compatible_llm`；`llm_configs.openai_compatible_llm.base_url` 设 `http://127.0.0.1:8787/v1`，`llm_api_key` 填与服务端一致的本地令牌，`model` 填模型名。`asr_config.asr_model` 可选 `fun_asr`（SenseVoiceSmall，首次需模型）；TTS `cosyvoice_tts` 需要另行部署服务，选择预训练音色，不克隆真人。设置界面关闭“允许AI主动发言”和“通过举手按钮提示AI发言”；重新启动后确认关闭生效。不要在画面或录像中展示任何自带 Live2D 模型，是否能完全禁用仍待实测。

服务端适配器只取最后一条 user，旧历史不会重复输入；其他角色消息被提取但 API 调用传入空 notices，当前路径不把 system 内容传给引擎。请求去重使用身份、历史轮数和文本的哈希：相同历史长度和同一文本可能误判重复，清空客户端历史或重复相同发言时须验证。外壳主动发言会伪造 user 输入，因此禁止启用。不要启用外壳屏幕、摄像头或工具功能。

## 待验收

- Mock：模型列表、非流式、SSE、重启后同一实例与记忆；Mock 台词不代表鲸鲸。
- DeepSeek：真实语气、持续记忆，确认未产生群聊数据和 system 污染。
- 外壳：十分钟纯聊，记录首句延迟、打断、语气、误接话、重复写入；测试主动发言确实关闭和不显示模型。
- 记忆审核流程完成后，OBS 分轨录制主播麦、TTS、游戏声；由主导者审核，保存问题清单。不得声称未经录制的项目已通过。

## 本次验证（2026-10-31）

- `npm test`：378 项通过，0 失败（需要允许本机回环监听）。
- `node experiments/video-cohost-smoke.mjs`：Mock 模型列表、非流式和 SSE 响应、重启后实例与已有记忆数量通过；只验证数量和实例，不证明模型回忆内容或记忆零污染。
- `verifyTemplate(jingjingTemplate)` 通过；拿 v1 预期与 v2 做 `checkTemplateVersion` 返回 `VERSION_MISMATCH`，尚未进行旧实例迁移。
- DeepSeek、语音外壳、10 分钟对话、录制、人工记忆审核均未实测。
