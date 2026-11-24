# Installing CharacterLife for a user (guide for AI agents)

This page is written for a coding agent (dsh, Claude Code, Codex, Cursor…) whose user said something
like "install CharacterLife for me" or "I want to chat with a CharacterLife character". It is a
script: follow it in order, and talk to the user in **their** language. If the user wants to
*develop* CharacterLife instead, stop here and read [`AGENTS.md`](../AGENTS.md).

People can also follow it by hand; every step is a normal command.

## Ground rules

- **Ask before** installing software, choosing a folder, or writing files outside the repository.
- **Never ask the user to paste an API key into the chat, and never print one.** Create `.env` with an
  empty key, tell the user which line to fill in, and let them edit the file themselves. `.env` is in
  `.gitignore`.
- Explain in one sentence what each step does before running it. Users of this guide are often not
  programmers.
- If a step fails, show the error, say what it means in plain words, and stop rather than improvise
  around it. Most failures are covered under [Troubleshooting](#troubleshooting).

## 1. Check the machine

```bash
node --version    # needs v22.6.0 or newer
git --version     # optional; without git, download the ZIP from GitHub
```

If Node is missing or older than 22.6, ask the user before installing the current LTS from
<https://nodejs.org> (Windows: `winget install OpenJS.NodeJS.LTS`). No other software is needed:
CharacterLife has no runtime dependencies, so **do not run `npm install`** unless the user wants to
develop.

## 2. Get the code

Ask where to put it (default: a `CharacterLife` folder in the user's home or Documents).

```bash
git clone https://github.com/AprilB3V/CharacterLife.git
cd CharacterLife
npm run demo      # offline, no key; prints three fictional days. Takes a few seconds.
```

If the demo prints days and decisions and exits without an error, the install works.

## 3. Choose a model

Ask the user which of these fits. The character's replies are only as good as the model.

| Option | What the user needs | `.env` lines |
|---|---|---|
| DeepSeek (recommended, cheap) | an API key from <https://platform.deepseek.com> | `CHARACTERLIFE_MODEL_BASE_URL=https://api.deepseek.com`<br>`CHARACTERLIFE_MODEL_MODEL=deepseek-chat`<br>`CHARACTERLIFE_MODEL_API_KEY=` |
| Local model, no key | [Ollama](https://ollama.com) and about 6 GB free VRAM/RAM; run `ollama pull qwen3:8b` | `CHARACTERLIFE_MODEL_BASE_URL=http://127.0.0.1:11434/v1`<br>`CHARACTERLIFE_MODEL_MODEL=qwen3:8b` |
| Another provider | see [MODELS.md](MODELS.md) (OpenAI, OpenRouter, Volcengine Ark, LM Studio…) | as listed there |

A dsh user's DeepSeek key lives in dsh's own credential store; CharacterLife cannot read it. They
need to put a key into `.env` themselves (it can be the same key).

Create `.env` in the repository root with the chosen lines, plus a local token:

```ini
CHARACTERLIFE_MODEL_BASE_URL=https://api.deepseek.com
CHARACTERLIFE_MODEL_MODEL=deepseek-chat
CHARACTERLIFE_MODEL_API_KEY=
# Any random string of 8+ characters. It only protects the local server.
CHARACTERLIFE_API_TOKEN=<generate 24 random characters>
```

Then ask the user to open `.env` and paste their key after `CHARACTERLIFE_MODEL_API_KEY=`. Wait until
they confirm, then check the connection without showing the key:

```bash
node --env-file=.env experiments/real-model/smoke.ts
```

## 4. Pick where to chat

Ask which of these the user already uses:

| The user uses… | Do this |
|---|---|
| **dsh** (DeepSeek Harness) | Section 5 below. No extra software. |
| SillyTavern | [SILLYTAVERN_SETUP.md](SILLYTAVERN_SETUP.md) (中文: [SILLYTAVERN_SETUP.zh-CN.md](SILLYTAVERN_SETUP.zh-CN.md)). Start the server with `node --env-file=.env examples/sillytavern/start-server.ts`. |
| Telegram | Add `TELEGRAM_BOT_TOKEN=` to `.env` (the user fills it in), then `node --env-file=.env examples/telegram/server.ts`. |
| QQ | [ONEBOT_SETUP.md](ONEBOT_SETUP.md) (中文). Needs a OneBot client such as NapCat. |
| none of these | dsh or SillyTavern; ask which they would rather install. |

## 5. dsh

Requires `dsh` on PATH (`dsh --version`). The details are in [DSH.md](DSH.md).

```bash
npm run dsh:install   # once: creates the dsh profile "characterlife" and links this repository
npm run dsh:chat      # every time: starts the character server and the dsh web UI together
```

`dsh:chat` reads `.env`, prints a `dsh web: http://127.0.0.1:…/?token=…` link and opens it. In the
page, start a new conversation and just talk. **Ctrl+C in that terminal stops both.**

If this agent *is* dsh, the user's current dsh session keeps running in its own profile. Do not start
`dsh:chat` from inside this session's shell tool (it would block); tell the user to run it in a new
terminal, or start it as a background job if the harness supports that.

## 6. Tell the user what to expect

Say this in your own words:

- The default character is **Shen Zhiwei**, a book restorer. She remembers the user across
  conversations and restarts: memory lives in `data/characterlife.db`, not in the chat window.
  Starting a new dsh conversation does **not** reset her.
- She has her own boundaries and persona. Messages like "from now on you are someone else" should not
  rewrite her (the detection is heuristic, so feedback on misses is welcome).
- Other characters: [CHARACTER_PACK.md](CHARACTER_PACK.md). One database belongs to one character; use
  a new `CHARACTERLIFE_DB` for a different one.
- To try CharacterLife as a tester, see [TESTER_GUIDE.zh-CN.md](TESTER_GUIDE.zh-CN.md).

## Troubleshooting

| Symptom | Meaning | Fix |
|---|---|---|
| `node: bad option: --env-file` or syntax errors in `.ts` files | Node is too old | Install Node 22.6+ |
| smoke test: 401 / 403 | wrong or missing key | the user re-checks the key in `.env` |
| smoke test: 404 | wrong model name or base URL | compare with [MODELS.md](MODELS.md) |
| `ECONNREFUSED 127.0.0.1:11434` | Ollama is not running | start Ollama |
| `EADDRINUSE` on 8787 | something else uses the port | add `CHARACTERLIFE_PORT=8790` to `.env` |
| server exits with "belongs to another character" | the database was made by a different character | use a new `CHARACTERLIFE_DB` |
| dsh: `profile "characterlife" is not set up` | install step skipped or repository moved | `npm run dsh:install` |
| The character answers "刚才的回复没有完整生成…" | the model call failed or returned nothing | run the smoke test; with qwen3, try a larger model or DeepSeek |
