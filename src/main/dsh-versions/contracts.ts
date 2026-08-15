/**
 * 版本管理契约:manifest 凭证、npm 运行器接口(可注入)、版本号工具。
 */

import { z } from 'zod'
import type { Result } from '../../shared/contracts'

export interface DshVersionManifest {
  readonly version: string
  readonly installedAt: number
  readonly entryPath: string
  readonly nodeMajorMinor: string
}

export const versionManifestSchema = z.object({
  version: z.string().min(1),
  installedAt: z.number(),
  entryPath: z.string().min(1),
  nodeMajorMinor: z.string().min(1)
})

export const MANIFEST_FILE_NAME = '.dsh-manifest.json'

/** 合法版本号(npm semver 的宽松子集,防路径注入)。 */
export const versionPattern = /^\d+\.\d+\.\d+(-[0-9A-Za-z.+-]+)?$/

export function isValidVersion(version: string): boolean {
  return versionPattern.test(version)
}

export interface InstalledVersion {
  readonly version: string
  readonly dir: string
  readonly entryPath: string
  readonly installedAt: number
  /** true = 随安装包内置(只读,不可删除);false = userData 里 npm 安装的。 */
  readonly builtin: boolean
}

/** npm 的最小接口:唯一上游耦合点,测试注入 fake。 */
export interface NpmRunner {
  listRegistryVersions(): Promise<Result<readonly string[]>>
  listDistTags(): Promise<Result<Readonly<Record<string, string>>>>
  installTo(
    prefixDir: string,
    version: string,
    onLine: (line: string) => void
  ): Promise<Result<null>>
}

/** 简化 semver 比较:数值段比较;无预发布 > 有预发布;预发布段数值/字典序。 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  for (let i = 0; i < 3; i++) {
    const diff = (pa.numeric[i] ?? 0) - (pb.numeric[i] ?? 0)
    if (diff !== 0) {
      return diff
    }
  }
  if (pa.pre === null && pb.pre === null) {
    return 0
  }
  if (pa.pre === null) {
    return 1
  }
  if (pb.pre === null) {
    return -1
  }
  const len = Math.max(pa.pre.length, pb.pre.length)
  for (let i = 0; i < len; i++) {
    const sa = pa.pre[i]
    const sb = pb.pre[i]
    if (sa === undefined) {
      return -1
    }
    if (sb === undefined) {
      return 1
    }
    const na = Number(sa)
    const nb = Number(sb)
    if (Number.isNaN(na) && Number.isNaN(nb)) {
      if (sa !== sb) {
        return sa < sb ? -1 : 1
      }
    } else if (Number.isNaN(na)) {
      return 1
    } else if (Number.isNaN(nb)) {
      return -1
    } else if (na !== nb) {
      return na - nb
    }
  }
  return 0
}

function parseVersion(v: string): { numeric: readonly number[]; pre: readonly string[] | null } {
  const [core, pre] = v.split('-', 2)
  const numeric = (core ?? '0.0.0')
    .split('.')
    .map((p) => Number.parseInt(p, 10) || 0)
  return { numeric, pre: pre === undefined ? null : pre.split('.') }
}
