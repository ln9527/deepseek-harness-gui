import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NpmRunner } from '../../src/main/dsh-versions/contracts'
import { VersionInstaller } from '../../src/main/dsh-versions/installer'
import type { InstallProgress } from '../../src/shared/ipc-types'

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeVersionsRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gui-installer-'))
  tmpDirs.push(dir)
  return dir
}

const noOpNpm: NpmRunner = {
  async listRegistryVersions() {
    return { ok: true as const, value: [] }
  },
  async listDistTags() {
    return { ok: true as const, value: {} }
  },
  async installTo() {
    return { ok: true as const, value: null }
  }
}

function makeInstaller(overrides: Partial<ConstructorParameters<typeof VersionInstaller>[0]> = {}): VersionInstaller {
  return new VersionInstaller({
    npm: noOpNpm,
    versionsRoot: makeVersionsRoot(),
    nodeMajorMinor: '22.22',
    getActiveVersion: () => null,
    isBuiltinVersion: () => false,
    ...overrides
  })
}

describe('VersionInstaller.remove 守卫', () => {
  it('内置版本拒绝删除', () => {
    const installer = makeInstaller({ isBuiltinVersion: (v) => v === '0.1.0-rc.6' })
    const result = installer.remove('0.1.0-rc.6')
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error.code).toBe('version-builtin')
  })

  it('active 版本拒绝删除', () => {
    const installer = makeInstaller({ getActiveVersion: () => '0.2.0' })
    const result = installer.remove('0.2.0')
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error.code).toBe('version-active')
  })

  it('非内置非 active 的已装版本可删除', () => {
    const versionsRoot = makeVersionsRoot()
    const entryDir = join(versionsRoot, '0.2.0', 'node_modules', '@deepseek-ai', 'dsh', 'lib')
    mkdirSync(entryDir, { recursive: true })
    writeFileSync(join(entryDir, 'bin.js'), '', 'utf8')
    writeFileSync(
      join(versionsRoot, '0.2.0', '.dsh-manifest.json'),
      JSON.stringify({ version: '0.2.0', installedAt: 1, entryPath: 'node_modules/@deepseek-ai/dsh/lib/bin.js', nodeMajorMinor: '22' }),
      'utf8'
    )
    const installer = makeInstaller({ versionsRoot })
    expect(installer.remove('0.2.0').ok).toBe(true)
  })
})

describe('VersionInstaller 安装 job', () => {
  it('单并发:进行中再 start 报错', () => {
    const release: { fn: (() => void) | null } = { fn: null }
    const hangingNpm: NpmRunner = {
      ...noOpNpm,
      installTo: () =>
        new Promise((resolve) => {
          release.fn = () => resolve({ ok: true as const, value: null })
        })
    }
    const installer = makeInstaller({ npm: hangingNpm })
    const first = installer.start('0.1.0')
    expect(first.ok).toBe(true)
    const second = installer.start('0.2.0')
    expect(second.ok).toBe(false)
    expect(second.ok ? '' : second.error.code).toBe('install-in-progress')
    release.fn?.()
  })

  it('进度推送覆盖 resolving→…→done,且触发 onInstalled', async () => {
    const versionsRoot = makeVersionsRoot()
    const realInstallNpm: NpmRunner = {
      ...noOpNpm,
      installTo: async (prefixDir, _version, onLine) => {
        onLine('fetching packages…')
        const entryDir = join(prefixDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
        mkdirSync(entryDir, { recursive: true })
        writeFileSync(join(entryDir, 'bin.js'), '', 'utf8')
        return { ok: true as const, value: null }
      }
    }
    const installedVersions: string[] = []
    const installer = makeInstaller({
      npm: realInstallNpm,
      versionsRoot,
      onInstalled: (v) => {
        installedVersions.push(v.version)
      }
    })
    const phases: InstallProgress[] = []
    installer.onProgress((p) => {
      phases.push(p)
    })
    const started = installer.start('0.1.0')
    expect(started.ok).toBe(true)
    await new Promise((resolve) => {
      setTimeout(resolve, 50)
    })
    expect(phases.map((p) => p.phase)).toContain('done')
    expect(phases.some((p) => p.phase === 'downloading')).toBe(true)
    expect(installedVersions).toEqual(['0.1.0'])
  })
})
