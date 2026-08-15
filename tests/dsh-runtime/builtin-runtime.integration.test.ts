/**
 * 内置运行时冒烟(真机链路):用 Electron-as-Node 从打包同款位置
 * (resources/dsh-runtime[-win]/<ver>)启动内置 DSH 树,验证
 * banner → host.describe → 优雅退出。CI 在 windows-latest 上跑
 * 即可覆盖 win32 树 + Windows 运行链(RUN_BUILTIN_SMOKE=1 触发)。
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { builtinRuntimeDirName } from '../../src/main/util/paths'

const enabled = process.env.RUN_BUILTIN_SMOKE === '1'
const runtimeRoot = join(process.cwd(), 'resources', builtinRuntimeDirName())
const electronBinary = join(
  process.cwd(),
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'Electron.app/Contents/MacOS/Electron'
)

describe.skipIf(!enabled)('内置 DSH 运行时冒烟(真实子进程)', () => {
  it.skipIf(!existsSync(runtimeRoot) || !existsSync(electronBinary))(
    'Electron-as-Node 启动内置树 → banner → host.describe → 退出',
    async () => {
      const versionDirs = existsSync(runtimeRoot)
        ? readdirSync(runtimeRoot).filter((d) => !d.startsWith('.') && !d.startsWith('tmp-'))
        : []
      expect(versionDirs.length, 'resources 下应有已物化的内置版本').toBeGreaterThan(0)
      const version = versionDirs[versionDirs.length - 1] ?? ''
      const entry = join(runtimeRoot, version, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      expect(existsSync(entry)).toBe(true)

      const dshHome = mkdtempSync(join(tmpdir(), 'dsh-smoke-home-'))
      const child = spawn(
        electronBinary,
        ['--expose-internals', entry, 'web', '--host', '127.0.0.1', '--port', '0'],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: dshHome },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
      let output = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        output += chunk.toString()
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        output += chunk.toString()
      })

      // 等 banner(CI 冷启动最多 60s)
      const banner = await waitForBanner()
      function waitForBanner(): Promise<number> {
        return new Promise((resolve, reject) => {
          const started = Date.now()
          const tick = (): void => {
            const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(output)
            if (match && match[1]) {
              resolve(Number.parseInt(match[1], 10))
            } else if (Date.now() - started > 60_000) {
              reject(new Error(`60s 内未见 banner。输出:\n${output.slice(0, 2000)}`))
            } else {
              setTimeout(tick, 500)
            }
          }
          setTimeout(tick, 500)
        })
      }
      expect(banner).toBeGreaterThan(0)

      // host.describe 二次确认(四象限信封)
      const response = await fetch(`http://127.0.0.1:${banner}/api/host.describe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${banner}` },
        body: JSON.stringify({ type: 'client-request', rpcId: 'smoke', method: 'host.describe', payload: {} })
      })
      expect(response.ok).toBe(true)
      const body = (await response.json()) as { result?: { ok?: boolean } }
      expect(body.result?.ok).toBe(true)

      // 优雅退出(Windows 下 kill 即终止,同样应退出)
      const exited = new Promise<void>((resolve) => {
        child.on('exit', () => {
          resolve()
        })
      })
      child.kill()
      await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000))])
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    },
    120_000
  )
})
