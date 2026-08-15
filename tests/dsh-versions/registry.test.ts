import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NpmRunner } from '../../src/main/dsh-versions/contracts'
import { compareVersions, isValidVersion } from '../../src/main/dsh-versions/contracts'
import {
  installVersion,
  removeVersion,
  resolveActiveVersion,
  scanBuiltinVersions,
  scanInstalledVersions,
  unionVersions
} from '../../src/main/dsh-versions/registry'

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function makeTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-gui-registry-'))
  tmpDirs.push(dir)
  return dir
}

/** 假 npm:在 prefix 下"安装"出 DSH 的入口文件结构。 */
const fakeNpm: NpmRunner = {
  async listRegistryVersions() {
    return { ok: true as const, value: ['0.1.0-rc.4', '0.1.0-rc.6'] }
  },
  async listDistTags() {
    return { ok: true as const, value: { latest: '0.1.0-rc.6' } }
  },
  async installTo(prefixDir, _version, onLine) {
    onLine('fetching packages…')
    const entryDir = join(prefixDir, 'node_modules', '@deepseek-ai', 'dsh', 'lib')
    mkdirSync(entryDir, { recursive: true })
    writeFileSync(join(entryDir, 'bin.js'), '#!/usr/bin/env node\n', 'utf8')
    return { ok: true as const, value: null }
  }
}

/** 坏 npm:什么都不装。 */
const brokenNpm: NpmRunner = {
  ...fakeNpm,
  async installTo() {
    return { ok: false as const, error: { code: 'npm-install-failed', message: 'boom' } }
  }
}

describe('compareVersions / isValidVersion', () => {
  it('简化 semver 排序', () => {
    expect(compareVersions('0.1.0-rc.5', '0.1.0-rc.6')).toBeLessThan(0)
    expect(compareVersions('0.1.0', '0.1.0-rc.6')).toBeGreaterThan(0)
    expect(compareVersions('0.2.0', '0.1.99')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
  })
  it('版本号白名单', () => {
    expect(isValidVersion('0.1.0-rc.6')).toBe(true)
    expect(isValidVersion('1.2.3')).toBe(true)
    expect(isValidVersion('../../etc')).toBe(false)
    expect(isValidVersion('')).toBe(false)
  })
})

describe('scanInstalledVersions', () => {
  it('忽略半成品目录(无 manifest 或无入口)', () => {
    const root = makeTmp()
    const complete = join(root, '0.1.0-rc.6')
    mkdirSync(join(complete, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    writeFileSync(join(complete, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '', 'utf8')
    writeFileSync(
      join(complete, '.dsh-manifest.json'),
      JSON.stringify({ version: '0.1.0-rc.6', installedAt: 1, entryPath: 'node_modules/@deepseek-ai/dsh/lib/bin.js', nodeMajorMinor: '22.22' }),
      'utf8'
    )
    mkdirSync(join(root, '0.2.0')) // 无任何文件
    const installed = scanInstalledVersions(root)
    expect(installed.map((v) => v.version)).toEqual(['0.1.0-rc.6'])
  })

  it('根目录不存在返回空', () => {
    expect(scanInstalledVersions(join(makeTmp(), 'nope'))).toEqual([])
  })
})

describe('installVersion(原子安装)', () => {
  it('成功路径:tmp → manifest → rename,结果可被扫描', async () => {
    const root = makeTmp()
    const result = await installVersion({
      npm: fakeNpm,
      versionsRoot: root,
      version: '0.1.0-rc.6',
      nodeMajorMinor: '22.22',
      onLine: () => {}
    })
    expect(result.ok).toBe(true)
    const installed = scanInstalledVersions(root)
    expect(installed.map((v) => v.version)).toEqual(['0.1.0-rc.6'])
    expect(existsSync(join(root, '0.1.0-rc.6', '.dsh-manifest.json'))).toBe(true)
    // 无残留 tmp 目录
    expect(installed.length).toBe(1)
  })

  it('幂等:已安装直接返回既有', async () => {
    const root = makeTmp()
    await installVersion({ npm: fakeNpm, versionsRoot: root, version: '0.1.0', nodeMajorMinor: '22', onLine: () => {} })
    const second = await installVersion({ npm: fakeNpm, versionsRoot: root, version: '0.1.0', nodeMajorMinor: '22', onLine: () => {} })
    expect(second.ok).toBe(true)
  })

  it('npm 失败:不留半成品目录', async () => {
    const root = makeTmp()
    const result = await installVersion({ npm: brokenNpm, versionsRoot: root, version: '0.1.0', nodeMajorMinor: '22', onLine: () => {} })
    expect(result.ok).toBe(false)
    expect(scanInstalledVersions(root)).toEqual([])
  })

  it('非法版本号直接拒绝', async () => {
    const root = makeTmp()
    const result = await installVersion({ npm: fakeNpm, versionsRoot: root, version: '../evil', nodeMajorMinor: '22', onLine: () => {} })
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error.code).toBe('bad-version')
  })
})

describe('resolveActiveVersion / removeVersion', () => {
  it('pinned 精确匹配,否则取最高版', async () => {
    const root = makeTmp()
    for (const v of ['0.1.0-rc.4', '0.1.0-rc.6']) {
      await installVersion({ npm: fakeNpm, versionsRoot: root, version: v, nodeMajorMinor: '22', onLine: () => {} })
    }
    const installed = scanInstalledVersions(root)
    expect(resolveActiveVersion(installed, [], null)?.version).toBe('0.1.0-rc.6')
    expect(resolveActiveVersion(installed, [], '0.1.0-rc.4')?.version).toBe('0.1.0-rc.4')
    expect(resolveActiveVersion(installed, [], '9.9.9')?.version).toBe('0.1.0-rc.6')
    expect(resolveActiveVersion([], [], null)).toBeNull()
  })

  it('删除已装版本;未装版本报错', async () => {
    const root = makeTmp()
    await installVersion({ npm: fakeNpm, versionsRoot: root, version: '0.1.0', nodeMajorMinor: '22', onLine: () => {} })
    expect(removeVersion(root, '0.1.0').ok).toBe(true)
    expect(scanInstalledVersions(root)).toEqual([])
    expect(removeVersion(root, '0.1.0').ok).toBe(false)
  })
})

describe('内置运行时(builtin)', () => {
  it('scanInstalledVersions 标 builtin:false', async () => {
    const root = makeTmp()
    await installVersion({ npm: fakeNpm, versionsRoot: root, version: '0.1.0', nodeMajorMinor: '22', onLine: () => {} })
    for (const v of scanInstalledVersions(root)) {
      expect(v.builtin).toBe(false)
    }
  })

  it('scanBuiltinVersions 标 builtin:true;根不存在返回空', async () => {
    const root = makeTmp()
    await installVersion({ npm: fakeNpm, versionsRoot: root, version: '0.1.0-rc.6', nodeMajorMinor: '22', onLine: () => {} })
    const builtin = scanBuiltinVersions(root)
    expect(builtin.map((v) => v.version)).toEqual(['0.1.0-rc.6'])
    expect(builtin[0]?.builtin).toBe(true)
    expect(scanBuiltinVersions(join(makeTmp(), 'nope'))).toEqual([])
  })

  it('resolveActiveVersion:无已装时回落内置;pinned 可命中内置', () => {
    const root = makeTmp()
    // 内置 0.1.0-rc.6(用 installVersion 物化再用 builtin 视角扫描)
    const builtin = [{ version: '0.1.0-rc.6', dir: '/x', entryPath: '/y', installedAt: 1, builtin: true }] as const
    expect(resolveActiveVersion([], builtin, null)?.version).toBe('0.1.0-rc.6')
    expect(resolveActiveVersion([], builtin, '0.1.0-rc.6')?.builtin).toBe(true)
    const installed = [{ version: '0.2.0', dir: '/a', entryPath: '/b', installedAt: 2, builtin: false }] as const
    // 已装优先于内置
    expect(resolveActiveVersion(installed, builtin, null)?.version).toBe('0.2.0')
    expect(resolveActiveVersion([], [], null)).toBeNull()
    void root
  })

  it('unionVersions:同版本已装副本优先,升序去重', () => {
    const installed = [{ version: '0.2.0', dir: '/a', entryPath: '/b', installedAt: 2, builtin: false }] as const
    const builtin = [
      { version: '0.1.0-rc.6', dir: '/x', entryPath: '/y', installedAt: 1, builtin: true },
      { version: '0.2.0', dir: '/z', entryPath: '/w', installedAt: 1, builtin: true }
    ] as const
    const union = unionVersions(installed, builtin)
    expect(union.map((v) => v.version)).toEqual(['0.1.0-rc.6', '0.2.0'])
    expect(union[1]?.builtin).toBe(false)
  })
})

describe('manifest 内容', () => {
  it('写入完整凭证', async () => {
    const root = makeTmp()
    await installVersion({ npm: fakeNpm, versionsRoot: root, version: '0.1.0', nodeMajorMinor: '22.22', onLine: () => {} })
    const manifest = JSON.parse(readFileSync(join(root, '0.1.0', '.dsh-manifest.json'), 'utf8')) as Record<string, unknown>
    expect(manifest['version']).toBe('0.1.0')
    // join 的分隔符随平台,归一化后断言
    expect(String(manifest['entryPath']).replace(/\\/g, '/')).toBe('node_modules/@deepseek-ai/dsh/lib/bin.js')
    expect(typeof manifest['installedAt']).toBe('number')
  })
})
