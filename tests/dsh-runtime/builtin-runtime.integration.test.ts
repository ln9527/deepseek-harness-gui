/**
 * Real bundled DSH boot. Version 0.1.5 authenticates the first visit using
 * the tokened banner URL, redirects to /, then requires the issued cookie.
 * On Windows use the bundled real node.exe, matching the shipped app.
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseBannerUrl } from '../../src/main/dsh-runtime/banner-parser'
import { builtinRuntimeDirName } from '../../src/main/util/paths'

const enabled = process.env.RUN_BUILTIN_SMOKE === '1'
const runtimeRoot = join(process.cwd(), 'resources', builtinRuntimeDirName())
const executable = process.platform === 'win32'
  ? join(process.cwd(), 'resources', 'node-runtime-win', 'node.exe')
  : join(process.cwd(), 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')

describe.skipIf(!enabled)('内置 DSH 运行时冒烟(真实子进程)', () => {
  it.skipIf(!existsSync(runtimeRoot) || !existsSync(executable))(
    '内置树启动 → tokened banner → 浏览器 cookie 门禁 → 退出',
    async () => {
      const versionDirs = readdirSync(runtimeRoot).filter((d) => !d.startsWith('.') && !d.startsWith('tmp-'))
      expect(versionDirs.length, 'resources 下应有已物化的内置版本').toBeGreaterThan(0)
      const version = versionDirs[versionDirs.length - 1] ?? ''
      const entry = join(runtimeRoot, version, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
      expect(existsSync(entry)).toBe(true)

      const dshHome = mkdtempSync(join(tmpdir(), 'dsh-smoke-home-'))
      const child = spawn(
        executable,
        [
          ...(process.platform === 'win32' ? [] : ['--expose-internals']),
          entry, 'web', '--host', '127.0.0.1', '--port', '0', '--no-open'
        ],
        {
          env: {
            ...process.env,
            ...(process.platform === 'win32' ? {} : { ELECTRON_RUN_AS_NODE: '1' }),
            DSH_HOME: dshHome
          },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
      let output = ''
      child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
      child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })

      try {
        const readyUrl = await new Promise<string>((resolve, reject) => {
          const deadline = Date.now() + 60_000
          const tick = (): void => {
            const url = parseBannerUrl(output)
            if (url) resolve(url)
            else if (Date.now() > deadline || child.exitCode !== null) reject(new Error('内置 DSH 未输出有效的就绪 URL'))
            else setTimeout(tick, 500)
          }
          tick()
        })
        const origin = new URL(readyUrl).origin
        expect(new URL(readyUrl).searchParams.has('token')).toBe(true)

        const bare = await fetch(`${origin}/`, { redirect: 'manual' })
        expect(bare.status).toBe(401)
        const firstVisit = await fetch(readyUrl, { redirect: 'manual' })
        expect(firstVisit.status).toBe(303)
        expect(firstVisit.headers.get('location')).toBe('/')
        const cookie = firstVisit.headers.get('set-cookie')?.split(';')[0]
        expect(cookie).toBeTruthy()
        const page = await fetch(`${origin}/`, { headers: { Cookie: cookie ?? '' }, redirect: 'manual' })
        expect(page.status).toBe(200)
        expect(page.headers.get('content-type')).toContain('text/html')
        expect((await page.text()).trimStart()).toMatch(/^<(?:!doctype html|html)/i)
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = new Promise<void>((resolve) => { child.once('exit', () => resolve()) })
          child.kill()
          await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 15_000))])
        }
        rmSync(dshHome, { recursive: true, force: true })
      }
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true)
    },
    120_000
  )
})
