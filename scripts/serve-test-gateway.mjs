/** Ephemeral loopback Gateway for manual Windows installer acceptance only. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const source = process.env.DSH_GATEWAY_SOURCE
const password = process.env.DSH_GUI_TEST_PASSWORD
const rawOrigin = process.env.DSH_GUI_TEST_GATEWAY_ORIGIN
if (!source || !password || !rawOrigin) {
  throw new Error('Set DSH_GATEWAY_SOURCE, DSH_GUI_TEST_PASSWORD and DSH_GUI_TEST_GATEWAY_ORIGIN')
}
if (password.length < 12) throw new Error('Choose a synthetic password of at least 12 characters')
const origin = new URL(rawOrigin)
if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port ||
    origin.origin !== rawOrigin || origin.pathname !== '/' || origin.search || origin.hash) {
  throw new Error('Gateway acceptance server requires http://127.0.0.1:<port>')
}
const moduleAt = (name) => import(pathToFileURL(join(resolve(source), 'gateway', 'src', name)).href)
const [{ AuthStore }, { loadConfig }, { createGateway }, { LoginThrottle }] = await Promise.all([
  moduleAt('auth-store.js'), moduleAt('config.js'), moduleAt('server.js'), moduleAt('throttle.js')
])
const dir = mkdtempSync(join(tmpdir(), 'dsh-gui-windows-gateway-'))
const config = loadConfig({ GATEWAY_DB_PATH: join(dir, 'identity.sqlite3'), GATEWAY_DESKTOP_AUTH_ENABLED: '1' })
const store = new AuthStore({ dbPath: config.dbPath })
const log = { info() {}, warn() {}, error() {} }
const username = 'synthetic-windows-member'
let server
try {
  await store.createUser(username, password)
  server = createGateway({ store, config, throttle: new LoginThrottle(), log })
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(Number(origin.port), '127.0.0.1', resolveListen)
  })
  process.stdout.write(`Temporary Gateway ready at ${origin.origin}; username: ${username}; Ctrl+C to stop.\n`)
  await new Promise((done) => { process.once('SIGINT', done); process.once('SIGTERM', done) })
} finally {
  if (server?.listening) {
    server.closeAllConnections()
    await new Promise((done) => server.close(done))
  }
  store.close()
  rmSync(dir, { recursive: true, force: true })
}
