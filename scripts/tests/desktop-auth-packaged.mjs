/**
 * Windows-only packaged Electron UI check. The loopback server below is a
 * deliberately narrow wire fixture; the separate gateway-contract test uses
 * the real Gateway source when it is available locally.
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { _electron as electron } from 'playwright-core'

const origin = process.env.DSH_GUI_TEST_GATEWAY_ORIGIN
if (origin !== 'http://127.0.0.1:47621') {
  throw new Error('Packaged UI acceptance requires the CI-only loopback origin http://127.0.0.1:47621')
}
const mode = process.argv[2] ?? '--unpacked'
if (mode !== '--unpacked' && mode !== '--nsis') throw new Error('Use --unpacked or --nsis')
if (mode === '--nsis' && process.platform !== 'win32') throw new Error('NSIS acceptance requires Windows')
const profileRoot = mkdtempSync(join(tmpdir(), 'dsh-gui-packaged-auth-'))
const userDataDir = join(profileRoot, 'DSH GUI Test')
const installDir = join(profileRoot, 'install')
const dshHome = join(profileRoot, 'DSH_HOME')
const evidenceDir = resolve('dist-win-test/ui-evidence')
for (const dir of [userDataDir, dshHome, evidenceDir]) mkdirSync(dir, { recursive: true })
const executablePath = mode === '--nsis' ? join(installDir, 'DSH GUI Test.exe')
  : process.platform === 'win32' ? resolve('dist-win-test/win-unpacked/DSH GUI Test.exe')
    : process.env.DSH_GUI_TEST_EXECUTABLE
let installed = false

function processSnapshot() {
  if (process.platform !== 'win32') return Promise.resolve('(not Windows)')
  // Tasklist is intentionally independent of NSIS's PowerShell/CIM process
  // detection. Never log environment variables, command lines, or credentials.
  return new Promise((resolveSnapshot) => {
    execFile('tasklist.exe', ['/fo', 'csv', '/nh'], { timeout: 15_000, maxBuffer: 2_000_000 }, (error, stdout) => {
      if (error) return resolveSnapshot(`tasklist failed: ${error.code ?? error.message}`)
      const relevant = stdout.split(/\r?\n/).filter((line) => /DSH GUI Test|Setup|Uninstall|powershell\.exe/i.test(line))
      resolveSnapshot(relevant.slice(0, 15).join(' | ') || '(no matching processes)')
    })
  })
}

function installSnapshot(stage) {
  const entries = existsSync(installDir) ? readdirSync(installDir) : []
  const uninstaller = entries.find((name) => /^Uninstall .*\.exe$/i.test(name))
  const appSize = existsSync(executablePath) ? statSync(executablePath).size : 0
  process.stdout.write(`NSIS ${stage}: appBytes=${appSize}; uninstaller=${Boolean(uninstaller)}; topLevelEntries=${entries.length}.\n`)
}

async function runInstaller(exe, args, timeoutMs) {
  const launchedAt = Date.now()
  const child = spawn(exe, args, { windowsHide: true, stdio: 'ignore' })
  const exited = new Promise((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', (code, signal) => {
      if (code === 0) resolveExit()
      else rejectExit(new Error(`NSIS ${args[0]} exited with code ${code}, signal ${signal}`))
    })
  })
  const inspect = async (stage) => {
    installSnapshot(stage)
    process.stdout.write(`NSIS ${stage}: processes=${await processSnapshot()}\n`)
  }
  await inspect('before wait')
  const interval = setInterval(() => { void inspect(`${Math.round((Date.now() - launchedAt) / 1000)}s`).catch(() => {}) }, 45_000)
  let timeoutHandle
  try {
    await Promise.race([
      exited,
      new Promise((_, rejectTimeout) => {
        timeoutHandle = setTimeout(() => rejectTimeout(new Error(`NSIS ${args[0]} exceeded ${timeoutMs / 1000}s`)), timeoutMs)
      })
    ])
    await inspect('completed')
  } catch (error) {
    await inspect('failed')
    if (child.pid && child.exitCode === null) {
      await new Promise((resolveKill) => {
        execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 15_000 }, () => resolveKill())
      })
      await exited.catch(() => {})
    }
    throw error
  } finally {
    clearInterval(interval)
    clearTimeout(timeoutHandle)
  }
}

async function installTestApp() {
  const version = JSON.parse(readFileSync(resolve('package.json'), 'utf8')).version
  const installer = resolve(`dist-win-test/DSH-GUI-Test-Setup-${version}-x64.exe`)
  if (!existsSync(installer)) throw new Error('Test-only NSIS installer is missing')
  // electron-builder 26.15.3's per-user NSIS template accepts /S and a final
  // unquoted /D= path. Use a disposable path and reject accidental spaces.
  if (/\s/.test(installDir)) throw new Error('NSIS test installation directory must have no spaces')
  process.stdout.write('Starting isolated silent test NSIS installation.\n')
  // The full bundled DSH tree has about 25,000 files. A Windows runner in
  // run 36046590988 finished extraction and registration after 430 seconds.
  await runInstaller(installer, ['/S', `/D=${installDir}`], 600_000)
  installed = true
  if (!existsSync(executablePath)) throw new Error('NSIS finished without installing the test executable in the requested directory')
  process.stdout.write('Isolated silent test NSIS installation completed.\n')
}

async function uninstallTestApp() {
  if (!existsSync(installDir)) return
  const uninstaller = readdirSync(installDir).find((name) => /^Uninstall .*\.exe$/i.test(name))
  if (!uninstaller) throw new Error('NSIS test uninstaller is missing')
  process.stdout.write('Starting isolated silent test NSIS uninstallation.\n')
  const uninstallerPath = join(installDir, uninstaller)
  await runInstaller(uninstallerPath, ['/S'], 120_000)
  // NSIS starts an uninstaller copy from %TEMP% and its original process can
  // return before the installed files are gone. Wait for observable removal.
  const deadline = Date.now() + 120_000
  while (existsSync(executablePath) || existsSync(uninstallerPath)) {
    if (Date.now() >= deadline) {
      installSnapshot('uninstall timeout')
      throw new Error('NSIS returned but installed executable or uninstaller remained after 120s')
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000))
  }
  process.stdout.write('Isolated silent test NSIS uninstallation completed.\n')
}

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

try {
  if (mode === '--nsis') await installTestApp()
  if (!executablePath || !existsSync(executablePath)) throw new Error('Test-only packaged Electron executable is missing')
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
  await window.screenshot({ path: join(evidenceDir, mode === '--nsis' ? 'connected-nsis.png' : 'connected-unpacked.png') })
  assert.ok(existsSync(join(userDataDir, 'desktop-credential.bin')))
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
  assert.equal(existsSync(join(userDataDir, 'desktop-credential.bin')), false)
  process.stdout.write('Packaged manage window: revocation and local credential clear passed.\n')
  await quitApp(app, window)
} catch (error) {
  if (manage) await manage.screenshot({ path: join(evidenceDir, mode === '--nsis' ? 'failure-nsis.png' : 'failure-unpacked.png'), timeout: 5_000 }).catch(() => {})
  testError = error
} finally {
  let cleanupError = null
  if (runningApp) await runningApp.close().catch(() => {})
  fixture.server.closeAllConnections()
  await new Promise((done) => fixture.server.close(done))
  try {
    if (installed) await uninstallTestApp()
    rmSync(profileRoot, { recursive: true, force: true, maxRetries: 60, retryDelay: 1_000 })
  } catch (error) { cleanupError = error }
  if (testError) throw testError
  if (cleanupError) throw cleanupError
}
