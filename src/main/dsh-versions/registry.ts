/**
 * 版本注册表:磁盘扫描 + 原子安装(tmp → manifest → rename)+ 删除。
 * 半成品目录(无 manifest 或无入口文件)不视为已安装。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Result } from '../../shared/contracts'
import { getLogger } from '../logger'
import { err, errFromUnknown, ok } from '../util/result'
import { dshEntryRelativePath } from '../util/paths'
import {
  compareVersions,
  isValidVersion,
  MANIFEST_FILE_NAME,
  versionManifestSchema,
  type InstalledVersion,
  type NpmRunner
} from './contracts'

const log = getLogger('versions')

/** 扫描 versions/ 下所有合法安装(含入口文件存在性校验)。 */
export function scanInstalledVersions(versionsRoot: string): readonly InstalledVersion[] {
  return scanVersionsRoot(versionsRoot, false)
}

/** 扫描安装包内置的 DSH 运行时树(Resources/dsh-runtime)。 */
export function scanBuiltinVersions(builtinRuntimeRoot: string): readonly InstalledVersion[] {
  return scanVersionsRoot(builtinRuntimeRoot, true)
}

function scanVersionsRoot(root: string, builtin: boolean): readonly InstalledVersion[] {
  if (!existsSync(root)) {
    return []
  }
  const results: InstalledVersion[] = []
  for (const name of readdirSync(root, { withFileTypes: true })) {
    if (!name.isDirectory() || name.name.startsWith('.') || name.name.startsWith('tmp-')) {
      continue
    }
    const installed = readInstalledVersion(root, name.name, builtin)
    if (installed !== null) {
      results.push(installed)
    }
  }
  return results.sort((a, b) => compareVersions(a.version, b.version))
}

function readInstalledVersion(root: string, version: string, builtin: boolean): InstalledVersion | null {
  const dir = join(root, version)
  const manifestPath = join(dir, MANIFEST_FILE_NAME)
  const entryPath = join(dir, dshEntryRelativePath())
  if (!existsSync(manifestPath) || !existsSync(entryPath)) {
    log.warn('ignoring incomplete version dir', { dir })
    return null
  }
  try {
    const raw: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const manifest = versionManifestSchema.safeParse(raw)
    if (!manifest.success || manifest.data.version !== version) {
      log.warn('ignoring version dir with bad manifest', { dir })
      return null
    }
    return {
      version,
      dir,
      entryPath,
      installedAt: manifest.data.installedAt,
      builtin
    }
  } catch (error) {
    log.warn('ignoring unreadable manifest', { dir, error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

/**
 * active 解析优先级:pinned 命中已装 → pinned 命中内置 → 已装最高版 → 内置最高版 → null。
 * (userData 无已装版本时自动用内置 → 全新机器零下载启动;装新版后靠 pinned 切换。)
 */
export function resolveActiveVersion(
  installed: readonly InstalledVersion[],
  builtin: readonly InstalledVersion[],
  pinned: string | null
): InstalledVersion | null {
  if (pinned !== null) {
    const installedMatch = installed.find((v) => v.version === pinned)
    if (installedMatch) {
      return installedMatch
    }
    const builtinMatch = builtin.find((v) => v.version === pinned)
    if (builtinMatch) {
      return builtinMatch
    }
    log.warn('pinned version not found, falling back', { pinned })
  }
  if (installed.length > 0) {
    return installed[installed.length - 1] ?? null
  }
  if (builtin.length > 0) {
    return builtin[builtin.length - 1] ?? null
  }
  return null
}

/** 版本并集(供 IPC 列表):同版本已装副本优先,compareVersions 升序。 */
export function unionVersions(
  installed: readonly InstalledVersion[],
  builtin: readonly InstalledVersion[]
): readonly InstalledVersion[] {
  const byVersion = new Map<string, InstalledVersion>()
  for (const version of [...builtin, ...installed]) {
    byVersion.set(version.version, version)
  }
  return [...byVersion.values()].sort((a, b) => compareVersions(a.version, b.version))
}

/** 原子安装:tmp 目录 npm install → 校验入口 → 写 manifest → rename。 */
export async function installVersion(deps: {
  readonly npm: NpmRunner
  readonly versionsRoot: string
  readonly version: string
  readonly nodeMajorMinor: string
  readonly onLine: (line: string) => void
}): Promise<Result<InstalledVersion>> {
  const { version } = deps
  if (!isValidVersion(version)) {
    return err('bad-version', `非法版本号:${version}`)
  }
  const finalDir = join(deps.versionsRoot, version)
  const existing = readInstalledVersion(deps.versionsRoot, version, false)
  if (existing !== null) {
    return ok(existing)
  }
  mkdirSync(deps.versionsRoot, { recursive: true })
  const tmpDir = join(deps.versionsRoot, `tmp-${version}-${Date.now()}`)
  try {
    const result = await deps.npm.installTo(tmpDir, version, deps.onLine)
    if (!result.ok) {
      return result
    }
    const entry = join(tmpDir, dshEntryRelativePath())
    if (!existsSync(entry)) {
      return err('install-incomplete', `安装完成但未找到入口文件 ${dshEntryRelativePath()}`)
    }
    const manifest = {
      version,
      installedAt: Date.now(),
      entryPath: dshEntryRelativePath(),
      nodeMajorMinor: deps.nodeMajorMinor
    }
    writeFileSync(join(tmpDir, MANIFEST_FILE_NAME), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    if (existsSync(finalDir)) {
      // 并发/残留:清掉旧的不完整目录
      rmSync(finalDir, { recursive: true, force: true })
    }
    renameSync(tmpDir, finalDir)
    const installed = readInstalledVersion(deps.versionsRoot, version, false)
    if (installed === null) {
      return err('install-verify-failed', 'rename 后校验失败')
    }
    log.info('version installed', { version })
    return ok(installed)
  } catch (error) {
    return errFromUnknown('install-failed', error)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

/** 删除版本目录(调用方负责拒绝 active 版本)。 */
export function removeVersion(versionsRoot: string, version: string): Result<null> {
  if (!isValidVersion(version)) {
    return err('bad-version', `非法版本号:${version}`)
  }
  const dir = join(versionsRoot, version)
  if (!existsSync(dir)) {
    return err('not-installed', `版本 ${version} 未安装`)
  }
  try {
    rmSync(dir, { recursive: true, force: true })
    log.info('version removed', { version })
    return ok(null)
  } catch (error) {
    return errFromUnknown('remove-failed', error)
  }
}
