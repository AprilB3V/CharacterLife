/**
 * 向本地 CL 发一句自然语言，并打印这一轮的完整证据链。
 *
 * 用法（在 CharacterLife 目录）：
 *   set "CHARACTERLIFE_API_TOKEN=<聊天 token>"
 *   npm run world:say -- "去桌子旁看看"
 *
 * 可选：
 *   CL_BASE_URL   默认 http://127.0.0.1:8787
 *   CL_IDENTITY   固定聊天身份；默认 local-default（与 dev-server 的单凭据一致）
 *
 * 输出包括：Provider 名称 / 模型、模型给出的动作候选、准入结果、actionId、
 * 以及这一轮结束时（进程内）的世界上下文。
 * 不打印 token 本身。
 */

const BASE = (process.env.CL_BASE_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')
const TOKEN = process.env.CHARACTERLIFE_API_TOKEN ?? ''
const IDENTITY = process.env.CL_IDENTITY ?? 'local-default'

const text = process.argv.slice(2).join(' ').trim()

function line(s = ''): void {
  console.log(s)
}

async function main(): Promise<void> {
  if (TOKEN.length < 8) {
    console.error('缺少 CHARACTERLIFE_API_TOKEN（≥8 位）。示例：')
    console.error('  set "CHARACTERLIFE_API_TOKEN=dev-chat-token-0123456789"')
    process.exit(2)
  }
  if (text.length === 0) {
    console.error('用法：npm run world:say -- "去桌子旁看看"')
    process.exit(2)
  }

  const started = Date.now()
  // 每次调用都是新的一条消息：带上唯一 x-request-id。
  // 不带的话服务端会用「身份 + 轮数 + 原文」的哈希做消息 id，
  // 同一句话重复发送会被判成重复消息，拿不到回复。
  const requestId = `say-${started.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const response = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      connection: 'close',
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      'x-characterlife-identity': IDENTITY,
      'x-request-id': requestId,
    },
    body: JSON.stringify({ text }),
  })
  const body = (await response.json()) as Record<string, unknown>

  line(`POST ${BASE}/v1/messages  →  HTTP ${response.status}  (${Date.now() - started}ms)`)
  line(`用户：${text}`)
  line(`身份：${IDENTITY}`)

  if (!response.ok) {
    line(`错误：${JSON.stringify(body)}`)
    process.exit(1)
  }

  line(`Provider：${String(body.provider)} / ${String(body.model)}`)
  line(`回复：${String(body.reply)}`)
  line(`实例：${String(body.instanceId)}`)
  line(`世界动作：${JSON.stringify(body.worldActions, null, 2)}`)
  line(`世界上下文：${JSON.stringify(body.worldContext, null, 2)}`)

  const admitted = ((body.worldActions as { admitted?: Array<{ actionId: string; status: string }> })?.admitted ?? [])
  if (admitted.length > 0) {
    line('')
    line(`→ 已登记 ${admitted.map((a) => `${a.actionId}(${a.status})`).join(', ')}。`)
    line('  Godot 侧应在 1 秒内领取并执行；执行完会用同一个 actionId 回执。')
    line('  用同样的命令再发一句（例如「刚才那件事怎么样了？」）可看到执行后的叙述。')
  } else {
    line('')
    line('→ 本轮没有登记世界动作。')
  }
}

void main().catch((err: unknown) => {
  console.error('发送失败：', err instanceof Error ? err.message : err)
  process.exit(1)
})
