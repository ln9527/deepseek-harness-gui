#!/usr/bin/env node
/**
 * 假 DSH:supervisor/壳的本地冒烟假体,零网络依赖。
 * 模拟真实 DSH 的可观测契约:stdout 就绪行 + /api/host.describe + SIGTERM→exit 0。
 *
 * DSH_FAKE_MODE:
 *   ok                 300ms 后打 banner 并常驻(默认)
 *   silent             常驻但永不打 banner(验证看门狗)
 *   die-fast           200ms 后 exit 1(验证退避重启)
 *   crash-after-ready  打 banner 后 2s exit 1(验证 ready 态崩溃)
 */

import http from 'node:http'

const mode = process.env.DSH_FAKE_MODE ?? 'ok'

if (mode === 'die-fast') {
  setTimeout(() => process.exit(1), 200)
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/host.describe') {
    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        type: 'server-response',
        rpcId: 'fake',
        result: { ok: true, value: { version: '0.0.0-fake' } }
      })
    )
    return
  }
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(
    '<!doctype html><html><head><meta charset="utf-8"><title>Fake DSH</title></head>' +
      '<body style="font-family:-apple-system;padding:48px"><h1>Fake DSH Web UI</h1>' +
      `<p>mode=${mode}</p></body></html>`
  )
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const bannerDelay = mode === 'silent' ? 60_000 : 300
  setTimeout(() => {
    console.log(`dsh web: http://127.0.0.1:${port}`)
    if (mode === 'crash-after-ready') {
      setTimeout(() => process.exit(1), 2000)
    }
  }, bannerDelay)
})

process.on('SIGTERM', () => {
  server.close()
  process.exit(0)
})
