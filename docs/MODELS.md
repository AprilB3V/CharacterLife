# Connecting a model

CharacterLife talks to any endpoint that implements the OpenAI **Chat Completions** API
(`POST {baseUrl}/chat/completions`). Without any configuration it falls back to the offline
`MockProvider`, so every demo and test runs with no key and no network.

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| `CHARACTERLIFE_MODEL_BASE_URL` | Endpoint root, up to `/v1` (or `/api/v3`); no `/chat/completions` | `https://api.deepseek.com` |
| `CHARACTERLIFE_MODEL_MODEL` | Model name as the endpoint expects it | `deepseek-chat` |
| `CHARACTERLIFE_MODEL_API_KEY` | Bearer token. **Optional for local servers** (`localhost`, `127.0.0.1`, `::1`, `*.localhost`) | — |
| `CHARACTERLIFE_REASONING` | `default` \| `off` \| `none` \| `low` \| `minimal`; see [Reasoning](#reasoning) | per model |

The older names `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL` and `DEEPSEEK_BASE_URL` still work;
the `CHARACTERLIFE_MODEL_*` names win when both are set. Keys are read from the environment
only and never written to disk or logs.

A real model is used when there is an API key, or when the base URL is a local server.
A remote base URL without a key stays on the mock provider.

The optional background "thinking" model is configured the same way with
`CHARACTERLIFE_THINK_BASE_URL`, `CHARACTERLIFE_THINK_MODEL` and `CHARACTERLIFE_THINK_API_KEY`.

## Examples

**DeepSeek**

```bash
CHARACTERLIFE_MODEL_API_KEY=sk-...
CHARACTERLIFE_MODEL_BASE_URL=https://api.deepseek.com
CHARACTERLIFE_MODEL_MODEL=deepseek-chat
```

**OpenAI**

```bash
CHARACTERLIFE_MODEL_API_KEY=sk-...
CHARACTERLIFE_MODEL_BASE_URL=https://api.openai.com/v1
CHARACTERLIFE_MODEL_MODEL=<model name>
```

**OpenRouter**

```bash
CHARACTERLIFE_MODEL_API_KEY=sk-or-...
CHARACTERLIFE_MODEL_BASE_URL=https://openrouter.ai/api/v1
CHARACTERLIFE_MODEL_MODEL=<provider/model>
```

**Volcengine Ark** (doubao, glm, deepseek)

```bash
CHARACTERLIFE_MODEL_API_KEY=<ark key>
CHARACTERLIFE_MODEL_BASE_URL=https://ark.cn-beijing.volces.com/api/v3
CHARACTERLIFE_MODEL_MODEL=<model or endpoint id>
```

**Ollama** (local, no key)

```bash
ollama pull qwen3:8b
CHARACTERLIFE_MODEL_BASE_URL=http://127.0.0.1:11434/v1
CHARACTERLIFE_MODEL_MODEL=qwen3:8b
```

**LM Studio** (local, no key): start the local server, then

```bash
CHARACTERLIFE_MODEL_BASE_URL=http://127.0.0.1:1234/v1
CHARACTERLIFE_MODEL_MODEL=<model id shown by LM Studio>
```

Check the connection with one call before anything else:

```bash
node experiments/real-model/smoke.ts
```

## What the kernel needs from a model

Every reply is a JSON envelope (`response_format: { type: "json_object" }`) carrying the line
the character says plus structured fields the kernel validates. A model that drifts out of JSON
does not break the character: the kernel retries, then falls back to a safe line and records the
failure. It does make the character feel less alive, so the share of valid envelopes is the number
that matters when picking a model.

Measure it on your own endpoint with the M0 baseline (a fixed 60-line script, every attempt
classified as valid or as one of the failure kinds F1–F6):

```bash
node experiments/real-model/baseline.ts --provider env --sessions 1 --max-calls 120
```

## Reasoning

Reasoning ("thinking") models spend output tokens before the JSON, which can cause timeouts,
truncated envelopes or slow replies. `CHARACTERLIFE_REASONING` maps to request fields; `default`
sends nothing, so endpoints that do not know these fields are never affected.

| Mode | Request field | Honoured by (measured) |
|---|---|---|
| `default` | none | everything |
| `off` (`disabled`) | `thinking: { type: "disabled" }` | Ark doubao, Ark deepseek; **ignored by Ollama** |
| `none` | `reasoning_effort: "none"` | Ollama |
| `low` / `minimal` | `reasoning_effort` | Ark doubao, Ark glm (`low`) |

Measured defaults (Ark models: M0, 300 turns each; Ollama: 60 turns, see below):

| Model | Default mode | Invalid replies (provider default → chosen mode) |
|---|---|---|
| `doubao-seed-2-1` | `off` | 19% → 0.7% |
| `glm-5-3` | `low` | 49.3% → 1.7% |
| `deepseek-v4-1` | `default` | 5.3% (kept) |
| `qwen3:*` (Ollama tags) | `none` | 3.3%; thinking on was valid but about twice as slow |

## Tested endpoints

Baseline: `experiments/real-model/baseline.ts`, character Shen Zhiwei, one 60-turn session,
kernel defaults. "Invalid" counts first attempts the kernel had to re-ask; every turn still
ended with a valid reply.

| Endpoint | Model | Reasoning | Valid replies | Invalid first attempts | Latency p50 / p95 | Memory probes |
|---|---|---|---|---|---|---|
| Ollama 0.40.16, RTX 3070 Ti Laptop 8 GB | `qwen3:8b` (5.2 GB) | `none` | 60 / 60 | 3.3% (1 missed memory write, 1 markup leak) | 4.7 s / 12.3 s | 8 / 9 |
| same | `qwen3:8b` | `default` (thinking on) | 5 / 5 (5-turn check) | 0% | 10.7 s / 16.5 s | — |
| Volcengine Ark | `deepseek-v4-1-flash` | `default` | M0: 300 turns | 5.3% | — | — |
| Volcengine Ark | `doubao-seed-2-1-pro` | `off` | M0: 300 turns | 0.7% | — | — |
| Volcengine Ark | `glm-5-3-flash` | `low` | M0: 300 turns | 1.7% | — | — |

An 8B local model on a laptop GPU is enough for a working character. These are small samples
on one machine; please report your own numbers.
