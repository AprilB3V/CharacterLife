# Chatting in dsh (DeepSeek Harness)

[中文](DSH.zh-CN.md)

dsh (DeepSeek Harness) is DeepSeek's agent harness. With the bundle in
[`integrations/dsh/`](../integrations/dsh) its web UI becomes a chat window for a CharacterLife
character. The character server keeps persona, memory and relationship; dsh only shows the
conversation. Tested with dsh 0.2.0-rc.2 on Windows.

## Setup

You need Node.js 22.6+, dsh on PATH, and a model in `.env` (see [AGENT_INSTALL.md §3](AGENT_INSTALL.md#3-choose-a-model)
or [MODELS.md](MODELS.md)).

```bash
npm run dsh:install   # once
npm run dsh:chat      # every time
```

`dsh:install` creates a dsh profile named `characterlife` from dsh's web template and links
`integrations/dsh` into it with `dsh plugin add`. It is safe to run again. Your other dsh profiles are
not touched.

`dsh:chat` reads `.env`, starts the CharacterLife server, waits for it, and starts `dsh characterlife`
pointed at it. dsh prints a link with a login token and opens the browser. Ctrl+C stops both.
Arguments after `--` go to dsh web, for example `npm run dsh:chat -- --port 8820 --no-open`.

| Variable | Default | Meaning |
|---|---|---|
| `CHARACTERLIFE_PORT` | `8787` | character server port |
| `CHARACTERLIFE_API_TOKEN` | random per run | token between dsh and the server |
| `CHARACTERLIFE_DB` | `data/characterlife.db` | one database per character |
| `CHARACTERLIFE_CHARACTER_PACK` | built-in Shen Zhiwei | [character pack](CHARACTER_PACK.md) folder |
| `CHARACTERLIFE_DSH_PROFILE` | `characterlife` | dsh profile name |
| `DSH_HOME` | `~/.dsh` | dsh home, as dsh itself uses it |

## How it works and what is switched off

CharacterLife's OpenAI-compatible endpoint treats the **last user message** of a request as what the
person just said, and any system text as untrusted outside context. A normal dsh coding session adds
its own messages to every request: a runtime-context snapshot and the skill list (both sent as user
messages after the real one), a coding persona, two dozen tool schemas, and a separate model call to
title each session. The character would answer the skill list.

The bundle ([`characterlife.patch.yml`](../integrations/dsh/characterlife.patch.yml)) therefore:

- registers the local server as a provider `characterlife` and makes it the default model;
- replaces dsh's agent presets (standard, ptc, minimal, cordis) with one preset `characterlife` that
  has no tools, no skills, an empty persona and no runtime context;
- turns off model-generated session titles;
- declares a 1M-token context window so dsh never asks the "model" to summarize the history.

With that, each turn is exactly one request containing the visible conversation. `dsh:chat` writes
`data/dsh-session.patch.yml` on every start to point the provider at the current port and character.

## Limits

- **This profile is for chatting only.** It has no tools; use your usual dsh profile for coding.
- dsh keeps its own copy of each conversation. The character's memory is in CharacterLife's database,
  so a new dsh conversation continues the same relationship, and deleting a dsh conversation does not
  make her forget.
- Text only, and no proactive messages: the character only speaks when you
  send a message. For messages she starts herself, use Telegram or QQ.
- The bundle relies on dsh entry ids (`preset-standard`, `session-title-llm`, …) of dsh 0.2. A later
  dsh may rename them; if the character starts replying to tool lists, check `dsh characterlife
  --dump-config` and open an issue.
