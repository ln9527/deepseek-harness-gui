/** Build a visibly separate Windows acceptance installer with a fixed local Gateway. */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const raw = process.env.DSH_GUI_TEST_GATEWAY_ORIGIN
let origin
try { origin = new URL(raw) } catch { throw new Error('Set DSH_GUI_TEST_GATEWAY_ORIGIN to a loopback origin, e.g. http://127.0.0.1:47621') }
if (origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || !origin.port ||
    origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || origin.origin !== raw) {
  throw new Error('The acceptance installer requires an exact loopback HTTP origin')
}

const env = { ...process.env, DSH_GUI_TEST_VARIANT: '1', DSH_GUI_TEST_GATEWAY_ORIGIN: origin.origin }
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env, shell: process.platform === 'win32' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run(process.execPath, [resolve('scripts/fetch-builtin-runtime.mjs'), '--platform', 'win32'])
run(pnpm, ['exec', 'electron-vite', 'build'])
const bundle = readFileSync(resolve('out/main/index.js'), 'utf8')
if (!bundle.includes('DSH GUI Test') || !bundle.includes(origin.origin) || bundle.includes('https://ds.ainativeorg.net')) {
  throw new Error('Main bundle must contain only the expected test name and fixed test Gateway origin')
}
run(pnpm, ['exec', 'electron-builder', '--win', '--x64', '--config', 'electron-builder.win.test.yml', '--publish', 'never'])
