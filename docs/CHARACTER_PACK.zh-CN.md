# 角色包

[English](CHARACTER_PACK.md) · **简体中文**

角色包是一个文件夹，用纯数据定义一个 CharacterLife 角色：她是谁、主动开口时怎么说、她自己的生活里会发生什么，以及可选的立绘。角色包**不含代码**，别人做的包可以放心校验、加载，不会执行对方写的任何东西。

```
my-character/
├── character.json        必需：清单、人设、主动台词、时间线
├── README.md             建议：角色介绍、内容提示
├── LICENSE               许可需要全文时附上
├── art/                  可选：立绘与表情图
└── notes/                可选：给应用用的知识文件
```

仓库自带两个角色包：示例角色 [`characters/jingjing`](../characters/jingjing/character.json)（鲸鲸，适合照着改；英文版 [`characters/jingjing-en`](../characters/jingjing-en/character.json)）和测试角色 [`characters/shen-zhiwei`](../characters/shen-zhiwei/character.json)（沈知微，生成的模板与内置默认模板完全一致，测试会检查这一点）。

## 不写 JSON 也能做角色

```bash
npm run studio
```

角色工作室会打开一个本机网页（终端里打印一次性链接），有三种开始方式：

- **导入 SillyTavern 角色卡**：PNG 或 JSON，支持 V1、V2、V3。描述变成背景，性格变成性格条目，场景变成「怎么对待你」，标签变成兴趣，卡面图片变成立绘。开场白、示例对话、卡片自带的提示词和世界书暂时没有对应字段，原文保存在 `knowledge/card.md`。
- **用几句话描述你的角色**，让已配置的模型（`CHARACTERLIFE_MODEL_*`，本地 Ollama 也行）起草所有字段。
- **从空白开始。**

卡片或模型没填到的字段会保留合理的默认值，并用黄色标出。页面边输入边校验，保存到 `characters/<id>/`。这样做出来的角色不会进 git：`.gitignore` 只保留示例角色包。

## 使用

`characters/`（或 `CHARACTERLIFE_CHARACTERS_DIR`）里的每个角色包会同时运行：

```bash
npm run st:server
```

SillyTavern 的模型下拉框里每个角色是一个模型 `characterlife/<id>`，选哪个就和谁聊。每个角色单独一个数据库，放在 `CHARACTERLIFE_DB` 旁边（`data/<id>.db`）；内置的沈知微沿用 `CHARACTERLIFE_DB`，已有对话不受影响。请求里没指定角色时由示例角色鲸鲸（`characters/jingjing`）回答（`CHARACTERLIFE_DEFAULT_CHARACTER=<id>` 可以换）。加载失败的包会被跳过并列出问题，其他角色照常启动。在工作室里保存后要重启服务。

只跑一个角色包，或者用 Telegram、OneBot 服务（各一个角色）时：

```bash
npm run pack:check -- path/to/my-character      # 校验，一次列出所有问题

export CHARACTERLIFE_CHARACTER_PACK=path/to/my-character
npm run st:server                                # telegram:server、onebot:server 同理
```

用 Docker 时把包挂载进容器，再把 `CHARACTERLIFE_CHARACTER_PACK` 指向挂载路径。

**每个角色用一个数据库。** 实例会记住创建时的模板；用别的角色建的数据库，服务启动时会直接停下并说明原因。

## character.json 要点

字段说明、长度上限和示例以英文版 [CHARACTER_PACK.md](CHARACTER_PACK.md) 为准；在文件里加上 `"$schema": "<相对路径>/docs/schemas/character-pack.v1.schema.json"`，VS Code 等编辑器会给出补全和提示。

- **清单**：`packFormat`（固定为 1）、`id`（小写字母、数字、单个连字符）、`version`、`name`、`language`（BCP 47，如 `zh-CN`；角色用这种语言回复，改它等于改人设，要升版本）、`summary`、`license`（SPDX，如 `CC-BY-4.0`）、`authors`。
- **`profile`**：不可变的核心人设。运行时冻结，任何聊天或模型输出都改不了它。`id`、`version`、`immutable` 由清单自动填入，不要自己写。
- **`voice.proactive`**：五种主动开口场景（`idle_check_in`、`promise_reminder`、`life_update`、`story_followup`、`boundary_pushback`）各至少一句。
- **`timeline`**：她自己生活里的事件，`at` 写成 `0`、`9h`、`2d`、`1d2h30m`。
- **`assets` / `knowledge`**：给桌宠等应用用的立绘、表情和知识文件，内核不读。路径必须是包内的相对路径；美术许可与文字不同时写在 `assets.license`。

## 改动与版本

加载时会对 `profile`、`voice`、`timeline` 计算哈希；每段关系（实例）都记着创建时的模板 id、版本和哈希，对不上就拒绝恢复，这样角色不会被悄悄改写。服务启动时会先检查，发现数据库属于别的角色或旧版本的这个角色，就停下并说明，而不是每条回复都失败。

改了 `profile`、`voice` 或 `timeline` 之后：

- **在工作室里改**：直接保存，人设有变化时会自动把 `version` 加 1。
- **手动改文件**：自己把 `version` 加 1。

下次启动时，用旧版本创建的对话会自动迁移到新版本，记忆和关系都保留。每次迁移都记录为 `template_migrated` 事件和一次身份修订，服务启动日志里会写 `角色已更新：…（inst_001 v1 → v2，记忆保留）`。

仍然会拦下的两种情况：内容变了但 `version` 没变（手改忘了升版本）；数据库是用比当前包更新的版本建的。设 `CHARACTERLIFE_AUTO_MIGRATE=false` 可以关掉自动迁移，改为提示。时间线事件在关系开始时写入，新版本里加的事件只对新关系生效。

`name`、`summary`、`authors`、`license`、`homepage`、`assets`、`knowledge` 不参与哈希，改了不用升版本。

## 分享

- 做原创角色，或你有权使用的角色；不要发布未经同意的真人角色，或别人作品里的角色。
- 在 `README.md` 里写明成人题材等内容提示。
- 文字和美术分别选好许可。
- 发布前跑一遍 `npm run pack:check`。

## 第 1 版格式的限制

- 一个包一个角色、一种语言。
- 不能在包里指定模型，沿用服务端的 `CHARACTERLIFE_MODEL_*`。
- 导入角色卡只是起点：卡片没有边界、关系规则、主动开口的台词和时间线，请检查黄色字段。开场白、示例对话和世界书保存在 `knowledge/card.md`，暂时不发给模型。
- 工作室暂时不能编辑时间线，会原样保留。
