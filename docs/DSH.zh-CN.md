# 在 dsh 里和角色聊天

[English](DSH.md)

dsh（DeepSeek Harness）是 DeepSeek 的 agent 框架。装上 [`integrations/dsh/`](../integrations/dsh) 里的插件包后，
dsh 的网页界面就成了 CharacterLife 角色的聊天窗口：人设、记忆和关系都由角色服务端保管，dsh 只负责显示对话。
已在 Windows + dsh 0.2.0-rc.2 上实测。

## 安装

需要 Node.js 22.6 以上、命令行里能用 `dsh`，以及在 `.env` 里配好模型（见 [AGENT_INSTALL.md 第 3 步](AGENT_INSTALL.md#3-choose-a-model)
或 [MODELS.md](MODELS.md)）。

```bash
npm run dsh:install   # 只需一次
npm run dsh:chat      # 每次聊天前
```

`dsh:install` 用 dsh 自带的 web 模板新建一个叫 `characterlife` 的 profile，再用 `dsh plugin add` 把
`integrations/dsh` 链接进去。重复运行没有副作用，也不会动你其他的 dsh profile。

`dsh:chat` 读取 `.env`，启动角色服务端，等它就绪后用同一个令牌启动 `dsh characterlife`。dsh 会打印一个带登录令牌的链接并打开浏览器。
在那个终端按 Ctrl+C 会同时关掉两者。`--` 后面的参数会传给 dsh web，例如 `npm run dsh:chat -- --port 8820 --no-open`。

| 变量 | 默认值 | 含义 |
|---|---|---|
| `CHARACTERLIFE_PORT` | `8787` | 角色服务端端口 |
| `CHARACTERLIFE_API_TOKEN` | 每次随机 | dsh 与服务端之间的令牌 |
| `CHARACTERLIFE_DB` | `data/characterlife.db` | 一个角色一个数据库 |
| `CHARACTERLIFE_CHARACTER_PACK` | 内置的沈知微 | [角色包](CHARACTER_PACK.zh-CN.md)目录 |
| `CHARACTERLIFE_DSH_PROFILE` | `characterlife` | dsh profile 名 |
| `DSH_HOME` | `~/.dsh` | dsh 主目录，和 dsh 自己的用法一致 |

## 原理和关掉了什么

CharacterLife 的 OpenAI 兼容接口把一次请求里**最后一条 user 消息**当作对方刚说的话，system 文本当作不可信的外部设定。
普通的 dsh 编程会话会在每次请求里加料：运行环境快照和技能列表（都以 user 消息的形式排在真实消息之后）、编程助手人设、
二十多个工具定义，另外每个会话还会单独调用一次模型来起标题。不处理的话，角色会去回复技能列表。

所以插件包（[`characterlife.patch.yml`](../integrations/dsh/characterlife.patch.yml)）做了这些事：

- 把本机服务端注册为 provider `characterlife`，设为默认模型；
- 用一个没有工具、没有技能、人设为空、不带运行环境快照的预设 `characterlife` 替换 dsh 自带的几个 agent 预设；
- 关掉用模型生成会话标题；
- 声明 100 万 token 的上下文，让 dsh 永远不会请“模型”去压缩历史。

这样每一轮对话只发一次请求，内容就是界面上看得到的对话。`dsh:chat` 每次启动时写一份 `data/dsh-session.patch.yml`，
把 provider 指向当前的端口和角色。

## 限制

- **这个 profile 只用来聊天**，没有任何工具；写代码请用你平时的 dsh profile。
- dsh 自己会保存一份对话记录，但角色的记忆在 CharacterLife 的数据库里。所以在 dsh 里新开会话，关系照样延续；删掉 dsh 的会话，她也不会忘。
- 只有文字，角色也不会主动发消息，只在你说话时回应。想让她主动找你，用 Telegram 或 QQ。
- 插件包依赖 dsh 0.2 的条目 id（`preset-standard`、`session-title-llm` 等）。以后的 dsh 可能改名；如果角色开始回复工具列表，
  请用 `dsh characterlife --dump-config` 检查并提 issue。
