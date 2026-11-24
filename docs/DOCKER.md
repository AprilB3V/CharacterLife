# Running with Docker

The image runs the CharacterLife API server: an OpenAI-compatible chat API that SillyTavern (or
any OpenAI client) can talk to, plus an optional Telegram bot in the same process. Character state
is stored in SQLite under `/data`.

## Quick start

```bash
git clone https://github.com/AprilB3V/CharacterLife.git
cd CharacterLife
cp .env.docker.example .env      # set CHARACTERLIFE_API_TOKEN, optionally a model
docker compose up -d
curl http://127.0.0.1:8787/healthz
```

With no model configured the character runs on the offline mock model, which is enough to check
the setup. In SillyTavern choose **Chat Completion → Custom (OpenAI-compatible)**:

| Field | Value |
|---|---|
| Base URL | `http://127.0.0.1:8787/v1` |
| API Key | your `CHARACTERLIFE_API_TOKEN` |
| Model | `characterlife/shen-zhiwei` |

Logs and shutdown:

```bash
docker compose logs -f characterlife
docker compose down              # data stays in the characterlife-data volume
```

## Choosing a model

Set the model in `.env` (all options are in [MODELS.md](MODELS.md)).

**Ollama on the host.** Inside the container `localhost` is the container itself, so use
`host.docker.internal`. Ollama does not check keys, but CharacterLife only skips the key for
addresses on the same machine, so set any value:

```bash
CHARACTERLIFE_MODEL_BASE_URL=http://host.docker.internal:11434/v1
CHARACTERLIFE_MODEL_MODEL=qwen3:8b
CHARACTERLIFE_MODEL_API_KEY=ollama
```

On Linux, Ollama listens on `127.0.0.1` by default and is not reachable from containers. Start it
with `OLLAMA_HOST=0.0.0.0`, or use the Ollama container below.

**Ollama in Docker.** The `ollama` profile adds an Ollama container:

```bash
# .env: CHARACTERLIFE_MODEL_BASE_URL=http://ollama:11434/v1, MODEL and API_KEY as above
docker compose --profile ollama up -d
docker compose exec ollama ollama pull qwen3:8b
```

GPU access for that container depends on your Docker setup (NVIDIA Container Toolkit on Linux,
WSL2 GPU support on Windows); without it Ollama runs on the CPU and is much slower.

**Hosted endpoints** (DeepSeek, OpenAI, OpenRouter, ...) need nothing special: set the three
variables and restart with `docker compose up -d`.

## Telegram

Add `TELEGRAM_BOT_TOKEN` (and preferably `TELEGRAM_ALLOWED_USER_IDS`) to `.env`. The bot uses long
polling, so no port needs to be opened. It handles private chats only.

## Data and backups

Everything the character remembers is in the `characterlife-data` volume (`/data/characterlife.db`).

```bash
docker compose stop characterlife
docker run --rm -v characterlife_characterlife-data:/data -v "$PWD":/backup alpine \
    cp /data/characterlife.db /backup/characterlife-backup.db
docker compose start characterlife
```

The volume name gets the Compose project prefix (the folder name, `characterlife` above);
`docker volume ls` shows the exact name.

## Without Compose

```bash
docker build -t characterlife .
docker run -d --name characterlife \
    -p 127.0.0.1:8787:8787 \
    -v characterlife-data:/data \
    -e CHARACTERLIFE_API_TOKEN=change-me-please \
    characterlife
```

## Troubleshooting

**`docker build` cannot pull `node:24-alpine` behind a local proxy** (`proxyconnect tcp: dial tcp
127.0.0.1:...: connection refused`). Inside Docker's VM, `127.0.0.1` is the VM itself. On Windows
with WSL 2, WSL's `autoProxy` copies the Windows system proxy into the VM as `HTTP_PROXY`, which
overrides Docker Desktop's own proxy settings. Add `autoProxy=false` under `[wsl2]` in
`%USERPROFILE%\.wslconfig`, run `wsl --shutdown`, and leave Docker Desktop's proxy on "system".
`docker info` should then show `HTTP Proxy: http.docker.internal:3128`.

**Replies look like the character did not understand you** when testing with `curl` on Windows: the
shell may pass non-ASCII text in a non-UTF-8 code page. Put the JSON body in a UTF-8 file and send it
with `--data-binary @body.json`.

## Tested

Docker Desktop 28.2.2 on Windows 11 (WSL 2), image 246 MB: health check, chat with the mock model
and with Ollama `qwen3:8b` on the host (about 4 s per reply), memory recalled after a container
restart, clean shutdown on `docker compose stop` (about 1 s, exit code 0). The `ollama` profile and
Linux hosts have not been tested yet.

## Security notes

- The port is published on `127.0.0.1` only. Changing it to `8787:8787` exposes the API to your
  network; anyone with the token can then chat as the bound identity. Put it behind HTTPS and a
  strong token before doing that.
- The owner console (`docs/CONSOLE.md`) only listens on loopback by design and is not available
  from the container in this version.
- The container runs as the unprivileged `node` user and the image contains no keys. Keys come
  from `.env`, which is git-ignored.
