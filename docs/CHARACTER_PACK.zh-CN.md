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

参考包是 [`characters/shen-zhiwei`](../characters/shen-zhiwei/character.json)（测试角色沈知微）。它生成的模板与内置默认模板完全一致，测试会检查这一点。

## 使用

```bash
npm run pack:check -- path/to/my-character      # 校验，一次列出所有问题

export CHARACTERLIFE_CHARACTER_PACK=path/to/my-character
npm run st:server                                # telegram:server、onebot:server 同理
```

SillyTavern 的模型列表里会出现 `characterlife/<id>`。用 Docker 时把包挂载进容器，再把 `CHARACTERLIFE_CHARACTER_PACK` 指向挂载路径。

**每个角色用一个数据库。** 实例会记住创建时的模板；用别的角色建的数据库，服务启动时会直接停下并说明原因。

## character.json 要点

字段说明、长度上限和示例以英文版 [CHARACTER_PACK.md](CHARACTER_PACK.md) 为准；在文件里加上 `"$schema": "<相对路径>/docs/schemas/character-pack.v1.schema.json"`，VS Code 等编辑器会给出补全和提示。

- **清单**：`packFormat`（固定为 1）、`id`（小写字母、数字、单个连字符）、`version`、`name`、`language`（BCP 47，如 `zh-CN`）、`summary`、`license`（SPDX，如 `CC-BY-4.0`）、`authors`。
- **`profile`**：不可变的核心人设。运行时冻结，任何聊天或模型输出都改不了它。`id`、`version`、`immutable` 由清单自动填入，不要自己写。
- **`voice.proactive`**：五种主动开口场景（`idle_check_in`、`promise_reminder`、`life_update`、`story_followup`、`boundary_pushback`）各至少一句。
- **`timeline`**：她自己生活里的事件，`at` 写成 `0`、`9h`、`2d`、`1d2h30m`。
- **`assets` / `knowledge`**：给桌宠等应用用的立绘、表情和知识文件，内核不读。路径必须是包内的相对路径；美术许可与文字不同时写在 `assets.license`。

## 改动与版本

加载时会对 `profile`、`voice`、`timeline` 计算哈希；每段关系（实例）都记着创建时的模板 id、版本和哈希，对不上就拒绝恢复，这样角色不会被悄悄改写。服务启动时会先检查，发现数据库属于别的角色或旧版本的这个角色，就停下并说明，而不是每条回复都失败。

- **写角色阶段**：用一个临时数据库（`CHARACTERLIFE_DB=data/draft.db`），每次改完删掉。
- **已经有人聊过之后**：升 `version`，然后换新数据库，或者迁移已有关系。迁移目前只有内核接口（`src/persistence/store.ts` 的 `migrateTemplate`，需要 `profile:write` 能力，会记录 `template_migrated` 事件），还没有现成命令。

`name`、`summary`、`authors`、`license`、`homepage`、`assets`、`knowledge` 不参与哈希，改了不用升版本。

## 分享

- 做原创角色，或你有权使用的角色；不要发布未经同意的真人角色，或别人作品里的角色。
- 在 `README.md` 里写明成人题材等内容提示。
- 文字和美术分别选好许可。
- 发布前跑一遍 `npm run pack:check`。

## 第 1 版格式的限制

- 一个包一个角色、一种语言。
- 不能在包里指定模型，沿用服务端的 `CHARACTERLIFE_MODEL_*`。
- 不自动导入 SillyTavern 角色卡：卡片字段大致对应 `background`、`traits`、`speechStyle`，但没有边界、关系规则和时间线，手写的包效果好得多。
