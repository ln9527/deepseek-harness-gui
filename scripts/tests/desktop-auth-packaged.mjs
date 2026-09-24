/**
 * Windows-only packaged Electron UI check. The loopback server below is a
 * deliberately narrow wire fixture; the separate gateway-contract test uses
 * the real Gateway source when it is available locally.
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { _electron as electron } from 'playwright-core'

const origin = process.env.DSH_GUI_TEST_GATEWAY_ORIGIN
if (origin !== 'http://127.0.0.1:47621') {
  throw new Error('Packaged UI acceptance requires the CI-only loopback origin http://127.0.0.1:47621')
}
const executablePath = process.platform === 'win32'
  ? resolve('dist-win-test/win-unpacked/DSH GUI Test.exe')
  : process.env.DSH_GUI_TEST_EXECUTABLE
if (!executablePath || !existsSync(executablePath)) {
  throw new Error('Test-only packaged Electron executable is missing')
}
const profileRoot = mkdtempSync(join(tmpdir(), 'dsh-gui-packaged-auth-'))
const roaming = process.platform === 'win32' ? join(profileRoot, 'Roaming') : join(profileRoot, 'Library/Application Support')
const local = join(profileRoot, 'Local')
const dshHome = join(profileRoot, 'DSH_HOME')
const evidenceDir = resolve('dist-win-test/ui-evidence')
for (const dir of [roaming, local, dshHome, evidenceDir]) mkdirSync(dir, { recursive: true })

function createFixture() {
  const username = 'synthetic-ci-member'
  let pending = null
  let token = null
  let revoked = false
  let meCalls = 0
  let logoutCalls = 0
  const respond = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  const readBody = async (req) => {
    let raw = ''
    for await (const chunk of req) {
      raw += chunk
      if (raw.length > 16_384) throw new Error('oversized request')
    }
    return JSON.parse(raw)
  }
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', origin).pathname
    if (req.method === 'GET' && (path === '/auth/desktop/verify' || path === '/auth/desktop/manage')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><title>DSH GUI synthetic acceptance</title><p>Synthetic local test only</p>')
      return
    }
    // The packaged client must use the pinned origin and native request shape.
    if (req.headers.origin !== origin || req.headers['x-dsh-desktop-client'] !== '1' ||
        req.headers.cookie !== undefined || req.headers['sec-fetch-site'] !== undefined) {
      respond(res, 403, { code: 'DEVICE_CLIENT_INVALID' })
      return
    }
    try {
      if (req.method === 'POST' && path === '/auth/desktop/start') {
        assert.match(String(req.headers['content-type']), /^application\/json/)
        assert.equal(req.headers.authorization, undefined)
        const body = await readBody(req)
        assert.match(body.challenge, /^[A-Za-z0-9_-]{43}$/)
        assert.match(body.deviceName, new RegExp(`^DSH GUI Test \\(${process.platform === 'win32' ? 'Windows' : 'macOS'}\\)`))
        pending = {
          requestId: randomBytes(12).toString('base64url'),
          userCode: randomBytes(4).toString('hex').toUpperCase(),
          challenge: body.challenge,
          approved: false,
          claimed: false
        }
        respond(res, 200, {
          requestId: pending.requestId, userCode: pending.userCode,
          verificationUrl: '/auth/desktop/verify', expiresInSeconds: 600, pollIntervalSeconds: 1
        })
        return
      }
      if (req.method === 'POST' && path === '/auth/desktop/poll') {
        assert.match(String(req.headers['content-type']), /^application\/json/)
        assert.equal(req.headers.authorization, undefined)
        const body = await readBody(req)
        if (!pending || pending.requestId !== body.requestId || pending.claimed ||
            createHash('sha256').update(body.verifier, 'utf8').digest('base64url') !== pending.challenge) {
          respond(res, 401, { code: 'DEVICE_FLOW_INVALID' })
          return
        }
        if (!pending.approved) {
          respond(res, 200, { status: 'pending', pollIntervalSeconds: 1 })
          return
        }
        pending.claimed = true
        token = randomBytes(32).toString('base64url')
        revoked = false
        respond(res, 200, { status: 'approved', token, user: { username, role: 'member' } })
        return
      }
      if (req.method === 'GET' && path === '/auth/desktop/me') {
        meCalls++
        if (revoked || !token || req.headers.authorization !== `Bearer ${token}`) {
          respond(res, 401, { code: 'DEVICE_TOKEN_INVALID' })
          return
        }
        respond(res, 200, { user: { username, role: 'member' } })
        return
      }
      if (req.method === 'POST' && path === '/auth/desktop/logout') {
        if (revoked || !token || req.headers.authorization !== `Bearer ${token}`) {
          respond(res, 401, { code: 'DEVICE_TOKEN_INVALID' })
          return
        }
        logoutCalls++
        revoked = true
        respond(res, 200, { ok: true })
        return
      }
      respond(res, 404, { code: 'NOT_FOUND' })
    } catch {
      respond(res, 400, { code: 'INVALID_REQUEST' })
    }
  })
  return {
    server,
    approve: (code) => {
      assert.ok(pending, 'start must precede approval')
      assert.equal(code, pending.userCode)
      pending.approved = true
    },
    revoke: () => { assert.ok(token); revoked = true },
    get meCalls() { return meCalls },
    get logoutCalls() { return logoutCalls }
  }
}

const fixture = createFixture()
const appEnv = {
  ...process.env,
  APPDATA: roaming,
  LOCALAPPDATA: local,
  DSH_HOME: dshHome,
  DSH_GUI_TEST_USER_DATA_DIR: join(roaming, 'DSH GUI Test'),
  DEEPSEEK_API_KEY: 'synthetic-ci-key-never-used',
  // The Gateway address is compile-time only; the app does not read this variable.
  DSH_GUI_TEST_GATEWAY_ORIGIN: undefined
}
if (process.platform === 'win32') delete appEnv.ELECTRON_RENDERER_URL
let runningApp = null
let manage = null

async function openAppAndManage() {
  const app = await electron.launch({
    executablePath,
    args: process.platform === 'win32' ? [] : [resolve('out/main/index.js')],
    env: appEnv,
    timeout: 30_000
  })
  runningApp = app
  const userData = await app.evaluate(({ app }) => app.getPath('userData'))
  assert.equal(userData.toLowerCase(), join(roaming, 'DSH GUI Test').toLowerCase())
  const main = await app.firstWindow()
  await main.waitForFunction(() => typeof window.dshShell?.openManageWindow === 'function')
  const managePromise = app.waitForEvent('window', { timeout: 20_000 })
  const result = await main.evaluate(() => window.dshShell.openManageWindow())
  assert.equal(result.ok, true)
  const window = await managePromise
  await window.locator('button[data-tab="account"]').click()
  manage = window
  return { app, window }
}

async function quitApp(app, window) {
  const process = app.process()
  const exited = once(process, 'exit')
  await window.evaluate(() => { void window.dshShell.quitApp() })
  await Promise.race([
    exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Packaged app did not exit cleanly')), 25_000))
  ])
  runningApp = null
  manage = null
}

try {
  await new Promise((resolveListen, rejectListen) => {
    fixture.server.once('error', rejectListen)
    fixture.server.listen(47621, '127.0.0.1', resolveListen)
  })
  let { app, window } = await openAppAndManage()
  await window.getByText('未连接组织账号').waitFor()
  await window.getByRole('button', { name: '连接组织账号' }).click()
  const code = await window.locator('.device-code').innerText({ timeout: 20_000 })
  fixture.approve(code)
  await window.getByText('已连接组织账号', { exact: true }).waitFor({ timeout: 20_000 })
  await window.getByText('账号：synthetic-ci-member').waitFor()
  await window.getByText(/凭据已由系统安全存储/).waitFor()
  await window.screenshot({ path: join(evidenceDir, 'connected.png') })
  assert.ok(existsSync(join(roaming, 'DSH GUI Test', 'desktop-credential.bin')))
  process.stdout.write('Packaged manage window: synthetic sign-in and encrypted save passed.\n')

  await quitApp(app, window)
  ;({ app, window } = await openAppAndManage())
  await window.getByText('已连接组织账号', { exact: true }).waitFor({ timeout: 20_000 })
  await window.getByText('账号：synthetic-ci-member').waitFor()
  assert.ok(fixture.meCalls >= 1, 'restart must revalidate with /me')
  process.stdout.write('Packaged manage window: restart and /me passed.\n')

  fixture.revoke()
  await window.locator('button[data-tab="versions"]').click()
  await window.locator('button[data-tab="account"]').click()
  await window.getByText('未连接组织账号').waitFor({ timeout: 20_000 })
  assert.ok(fixture.meCalls >= 2, 'account re-entry must revalidate after revocation')
  assert.equal(existsSync(join(roaming, 'DSH GUI Test', 'desktop-credential.bin')), false)
  process.stdout.write('Packaged manage window: revocation and local credential clear passed.\n')
  await quitApp(app, window)
} catch (error) {
  if (manage) await manage.screenshot({ path: join(evidenceDir, 'failure.png'), timeout: 5_000 }).catch(() => {})
  throw error
} finally {
  if (runningApp) await runningApp.close().catch(() => {})
  fixture.server.closeAllConnections()
  await new Promise((done) => fixture.server.close(done))
  rmSync(profileRoot, { recursive: true, force: true })
}
