/**
 * Windows-only packaged Electron UI check. The loopback server below is a
 * deliberately narrow wire fixture; the separate gateway-contract test uses
 * the real Gateway source when it is available locally.
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { _electron as electron } from 'playwright-core'

const origin = process.env.DSH_GUI_TEST_GATEWAY_ORIGIN
if (origin !== 'http://127.0.0.1:47621') {
  throw new Error('Packaged UI acceptance requires the CI-only loopback origin http://127.0.0.1:47621')
}
if (process.argv[2] !== '--unpacked') throw new Error('Use --unpacked for the packaged payload UI check')
const profileRoot = mkdtempSync(join(tmpdir(), 'dsh-gui-packaged-auth-'))
const userDataDir = join(profileRoot, 'DSH GUI Test')
const dshHome = join(profileRoot, 'DSH_HOME')
const evidenceDir = resolve('dist-win-test/ui-evidence')
for (const dir of [userDataDir, dshHome, evidenceDir]) mkdirSync(dir, { recursive: true })
const executablePath = process.platform === 'win32'
  ? resolve('dist-win-test/win-unpacked/DSH GUI Test.exe')
  : process.env.DSH_GUI_TEST_EXECUTABLE

function createFixture() {
  const username = 'synthetic-ci-member'
  let pending = null
  let token = null
  let projectCardsGrant = null
  let projectCardsRevoked = false
  let revoked = false
  let meCalls = 0
  let projectCardsCalls = 0
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
          projectCards: false,
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
        projectCardsGrant = pending.projectCards ? randomBytes(32).toString('base64url') : null
        projectCardsRevoked = false
        revoked = false
        respond(res, 200, { status: 'approved', token, user: { username, role: 'member' },
          ...(projectCardsGrant ? { projectCardsGrant } : {}) })
        return
      }
      if (req.method === 'GET' && path === '/auth/desktop/project-cards') {
        projectCardsCalls++
        if (!projectCardsGrant || projectCardsRevoked || req.headers.authorization !== `Bearer ${projectCardsGrant}`) {
          respond(res, 401, { code: 'DESKTOP_PROJECT_GRANT_INVALID' })
          return
        }
        respond(res, 200, { projects: [{ projectId: 'synthetic-ci-project', title: 'Synthetic CI project',
          owner: username, role: 'member', updatedAt: '2026-09-25T00:00:00.000Z' }] })
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
    approve: (code, { projectCards = false } = {}) => {
      assert.ok(pending, 'start must precede approval')
      assert.equal(code, pending.userCode)
      pending.approved = true
      pending.projectCards = projectCards
    },
    revokeCards: () => { assert.ok(projectCardsGrant); projectCardsRevoked = true },
    revoke: () => { assert.ok(token); revoked = true },
    get meCalls() { return meCalls },
    get projectCardsCalls() { return projectCardsCalls },
    get secrets() { return [token, projectCardsGrant].filter(Boolean) },
    get logoutCalls() { return logoutCalls }
  }
}

const fixture = createFixture()
const appEnv = {
  ...process.env,
  DSH_HOME: dshHome,
  DSH_GUI_TEST_USER_DATA_DIR: userDataDir,
  DEEPSEEK_API_KEY: 'synthetic-ci-key-never-used',
  // The Gateway address is compile-time only; the app does not read this variable.
  DSH_GUI_TEST_GATEWAY_ORIGIN: undefined
}
if (process.platform === 'win32') delete appEnv.ELECTRON_RENDERER_URL
let runningApp = null
let manage = null
let testError = null

async function openAppAndManage() {
  const app = await electron.launch({
    executablePath,
    args: process.platform === 'win32' ? [] : [resolve('out/main/index.js')],
    env: appEnv,
    timeout: 30_000
  })
  runningApp = app
  const userData = await app.evaluate(({ app }) => app.getPath('userData'))
  assert.equal(userData.toLowerCase(), userDataDir.toLowerCase())
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

async function assertNoCredentialExposure(main, window) {
  const rendererValues = await Promise.all([main, window].map(page => page.evaluate(async () => ({
    html: document.documentElement.outerHTML,
    identity: await window.dshShell.getDesktopAuth(),
    logs: await window.dshShell.getLogTail({ maxLines: 500 })
  }))))
  const cards = await window.evaluate(() => window.dshShell.getDesktopProjectCards())
  const exposed = JSON.stringify([...rendererValues, cards])
  const persisted = readFileSync(join(userDataDir, 'desktop-credential.bin')).toString('utf8')
  const logFile = join(userDataDir, 'logs', 'main.log')
  const logs = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  for (const secret of fixture.secrets) {
    assert.ok(!exposed.includes(secret), 'desktop credential leaked through renderer or IPC')
    assert.ok(!persisted.includes(secret), 'desktop credential persisted as plaintext')
    assert.ok(!logs.includes(secret), 'desktop credential leaked through app log')
  }
}

try {
  if (!executablePath || !existsSync(executablePath)) throw new Error('Test-only packaged Electron executable is missing')
  await new Promise((resolveListen, rejectListen) => {
    fixture.server.once('error', rejectListen)
    fixture.server.listen(47621, '127.0.0.1', resolveListen)
  })
  let { app, window } = await openAppAndManage()
  let main = await app.firstWindow()
  const forbidden = await main.evaluate(() => window.dshShell.getDesktopProjectCards())
  assert.equal(forbidden.ok, false)
  assert.equal(forbidden.error.code, 'AUTH_IPC_FORBIDDEN')
  await window.getByText('未连接组织账号').waitFor()
  await window.getByRole('button', { name: '连接组织账号' }).click()
  const code = await window.locator('.device-code').innerText({ timeout: 20_000 })
  fixture.approve(code, { projectCards: true })
  await window.getByText('已连接组织账号', { exact: true }).waitFor({ timeout: 20_000 })
  await window.getByText('账号：synthetic-ci-member').waitFor()
  await window.getByText(/凭据已由系统安全存储/).waitFor()
  await window.getByText('Synthetic CI project').waitFor({ timeout: 20_000 })
  assert.ok(fixture.projectCardsCalls >= 1, 'opted-in connection must read project cards with its separate grant')
  await assertNoCredentialExposure(main, window)
  await window.screenshot({ path: join(evidenceDir, 'connected-unpacked.png') })
  assert.ok(existsSync(join(userDataDir, 'desktop-credential.bin')))
  process.stdout.write('Packaged manage window: opted-in project card, credential isolation and encrypted save passed.\n')

  const readsBeforeRestart = fixture.projectCardsCalls
  await quitApp(app, window)
  ;({ app, window } = await openAppAndManage())
  main = await app.firstWindow()
  await window.getByText('已连接组织账号', { exact: true }).waitFor({ timeout: 20_000 })
  await window.getByText('账号：synthetic-ci-member').waitFor()
  await window.getByText('Synthetic CI project').waitFor({ timeout: 20_000 })
  assert.ok(fixture.meCalls >= 1, 'restart must revalidate with /me')
  assert.ok(fixture.projectCardsCalls > readsBeforeRestart, 'restart must read project cards again')
  await assertNoCredentialExposure(main, window)
  process.stdout.write('Packaged manage window: restart, /me and fresh project-card read passed.\n')

  fixture.revokeCards()
  await window.locator('button[data-tab="versions"]').click()
  await window.locator('button[data-tab="account"]').click()
  await window.getByText(/项目卡授权已失效，列表已隐藏/).waitFor({ timeout: 20_000 })
  assert.equal(await window.getByText('Synthetic CI project').count(), 0)
  assert.ok(existsSync(join(userDataDir, 'desktop-credential.bin')), 'identity stays connected after card grant revocation')
  process.stdout.write('Packaged manage window: revoked project grant hides the card without ending identity.\n')

  const readsBeforeNoGrant = fixture.projectCardsCalls
  await window.getByRole('button', { name: '断开并重新授权' }).click()
  const noGrantCode = await window.locator('.device-code').innerText({ timeout: 20_000 })
  fixture.approve(noGrantCode)
  await window.getByText('已连接组织账号', { exact: true }).waitFor({ timeout: 20_000 })
  await window.getByText(/这台设备还没有项目卡授权/).waitFor({ timeout: 20_000 })
  assert.equal(await window.getByText('Synthetic CI project').count(), 0)
  assert.equal(fixture.projectCardsCalls, readsBeforeNoGrant, 'no-grant pairing must not request project cards')
  await assertNoCredentialExposure(main, window)
  process.stdout.write('Packaged manage window: no-grant pairing hides cards without requesting project metadata.\n')

  fixture.revoke()
  await window.locator('button[data-tab="versions"]').click()
  await window.locator('button[data-tab="account"]').click()
  await window.getByText('未连接组织账号').waitFor({ timeout: 20_000 })
  assert.ok(fixture.meCalls >= 2, 'account re-entry must revalidate after revocation')
  assert.equal(existsSync(join(userDataDir, 'desktop-credential.bin')), false)
  process.stdout.write('Packaged manage window: revocation and local credential clear passed.\n')
  await quitApp(app, window)
} catch (error) {
  if (manage) await manage.screenshot({ path: join(evidenceDir, 'failure-unpacked.png'), timeout: 5_000 }).catch(() => {})
  testError = error
} finally {
  let cleanupError = null
  if (runningApp) await runningApp.close().catch(() => {})
  fixture.server.closeAllConnections()
  await new Promise((done) => fixture.server.close(done))
  try {
    rmSync(profileRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  } catch (error) { cleanupError = error }
  if (testError) throw testError
  if (cleanupError) throw cleanupError
}
