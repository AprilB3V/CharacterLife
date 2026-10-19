/**
 * 假 OneBot 11 网关（测试替身，用来先证明「本服务是好的」，再去查真网关/QQ）
 *
 * 它只实现启动脚本与自检需要的三个 action：
 *   POST /get_login_info     → 返回一个假的 QQ 号与昵称
 *   POST /send_private_msg   → 打印收到的私聊消息，返回 ok
 *   POST /send_group_msg     → 打印收到的群消息，返回 ok
 *
 * 用法：
 *   node scripts/fake-onebot-gateway.mjs 3999
 *   # 另开一个窗口，把它当作网关：
 *   .\scripts\start-onebot.cmd -ApiBase http://127.0.0.1:3999
 *
 * 它不是真网关：不连 QQ、不处理登录、不实现任何其他 action。
 * 只用于本地验证「配置 → 上报 → 引擎 → 发送」这条链路。
 */

import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 3999)
let callCount = 0

const server = createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const action = (req.url ?? '/').replace(/^\//, '')
    let body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      /* 空 body 也允许 */
    }
    callCount++
    const auth = req.headers.authorization ?? '-'
    console.log(`[fake-gateway] #${callCount} ${action} auth=${auth} body=${JSON.stringify(body)}`)

    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', connection: 'close' })
    if (action === 'get_login_info') {
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 10001, nickname: '假网关（测试替身）' } }))
      return
    }
    if (action === 'send_private_msg' || action === 'send_group_msg') {
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 4242 } }))
      return
    }
    res.end(JSON.stringify({ status: 'failed', retcode: 1404, data: null, wording: `未实现 action: ${action}` }))
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[fake-gateway] listening on http://127.0.0.1:${port}`)
  console.log('[fake-gateway] 这是测试替身，不会连 QQ；Ctrl+C 退出')
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[fake-gateway] 收到 ${signal}，共处理 ${callCount} 次调用`)
    server.close(() => process.exit(0))
  })
}
