/**
 * Node 运行时选择:Electron 内嵌 Node(需 ≥22.13,node:sqlite 地板)
 * 不满足时回退系统 node。解析/判定为纯函数,文件系统探测由调用方注入。
 */

import { execFileSync } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { join } from 'node:path'

export interface NodeExecResolution {
  readonly exec: string
  readonly useRunAsNode: boolean
  readonly source: 'electron' | 'system'
  readonly reason: string
  /** 需要附加在入口文件之前的 node CLI flag(如 --expose-internals)。 */
  readonly nodeFlags: readonly string[]
}

/** "v22.22.2" / "22.22.2" → 是否满足 major.minor >= 22.13。 */
export function satisfiesNodeFloor(version: string, floorMajor = 22, floorMinor = 13): boolean {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!match || match[1] === undefined || match[2] === undefined) {
    return false
  }
  const major = Number.parseInt(match[1], 10)
  const minor = Number.parseInt(match[2], 10)
  if (major !== floorMajor) {
    return major > floorMajor
  }
  return minor >= floorMinor
}

/** 平台相关的探测规则(默认按当前平台;测试可注入)。 */
export interface NodeLookupSpec {
  readonly delimiter: string
  readonly names: readonly string[]
  readonly extraPaths: readonly string[]
}

export function defaultNodeLookupSpec(platform: NodeJS.Platform = process.platform): NodeLookupSpec {
  return platform === 'win32'
    ? {
        delimiter: ';',
        names: ['node.exe'],
        extraPaths: ['C:\\Program Files\\nodejs\\node.exe']
      }
    : {
        delimiter: ':',
        names: ['node'],
        extraPaths: ['/opt/homebrew/bin/node', '/usr/local/bin/node']
      }
}

/** 从 PATH 值与常见安装位中找出可执行的 node(探测由调用方注入以便测试)。 */
export function findSystemNode(
  envPath: string,
  exists: (p: string) => boolean = defaultExists,
  spec: NodeLookupSpec = defaultNodeLookupSpec()
): string | null {
  const pathDirs = envPath.split(spec.delimiter).filter((p) => p.length > 0)
  const candidates = [
    ...pathDirs.flatMap((dir) => spec.names.map((name) => join(dir, name))),
    ...spec.extraPaths
  ]
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (!seen.has(candidate) && exists(candidate)) {
      return candidate
    }
    seen.add(candidate)
  }
  return null
}

export function defaultExists(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** 用探测到的系统 node 实际跑 `node --version` 验证版本。 */
export function systemNodeVersion(nodePath: string): string | null {
  try {
    return execFileSync(nodePath, ['--version'], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

export function resolveNodeExec(input: {
  readonly electronExecPath: string
  readonly electronNodeVersion: string
  readonly envPath: string
  readonly exists?: (p: string) => boolean
}): NodeExecResolution {
  // 优先系统 node:npm 安装的原生模块(node-pty / node-addon-require-builtin)
  // 按系统 node ABI 编译,天然匹配;Electron 内嵌 Node 的 ABI 不同,会踩坑。
  const systemNode = findSystemNode(input.envPath, input.exists)
  if (systemNode) {
    const version = systemNodeVersion(systemNode)
    if (version && satisfiesNodeFloor(version)) {
      return {
        exec: systemNode,
        useRunAsNode: false,
        source: 'system',
        nodeFlags: [],
        reason: `使用系统 node ${systemNode} (${version}),与 DSH 原生模块 ABI 匹配`
      }
    }
  }
  if (satisfiesNodeFloor(input.electronNodeVersion)) {
    return {
      exec: input.electronExecPath,
      useRunAsNode: true,
      source: 'electron',
      // DSH 的 cordis loader 需要 --expose-internals 初始化 HMR 服务
      // (系统 node 下由 node-addon-require-builtin 兜底;Electron 下必须显式传)
      nodeFlags: ['--expose-internals'],
      reason: `无满足地板的系统 node,使用 Electron 内嵌 Node ${input.electronNodeVersion}(+--expose-internals)`
    }
  }
  throw new Error(
    `未找到满足 DSH 要求(Node >= 22.13)的运行时:Electron 内嵌 ${input.electronNodeVersion}` +
      (systemNode ? ',系统 node 版本过低' : ',且未找到系统 node')
  )
}
