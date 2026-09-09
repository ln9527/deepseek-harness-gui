/**
 * Node 运行时选择:内置真 node.exe(Windows)→ 系统 node → Electron 内嵌
 * Node(+--expose-internals)。解析/判定为纯函数,文件系统与版本探测由调用方注入。
 */

import { execFileSync } from 'node:child_process'
import { accessSync, constants, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { z } from 'zod'

export interface NodeExecResolution {
  readonly exec: string
  readonly useRunAsNode: boolean
  readonly source: 'bundled' | 'system' | 'electron'
  readonly reason: string
  /** 需要附加在入口文件之前的 node CLI flag(如 --expose-internals)。 */
  readonly nodeFlags: readonly string[]
}

/** 随 Windows 安装包内置的真 node.exe(fetch:runtime --platform win32 物化)。 */
export interface BundledNodeSpec {
  readonly exec: string
  readonly version: string
}

/**
 * DSH 的 Node 地板,对齐上游 engines `^22.19 || >=24`:
 * - 22 系须 ≥22.19。旧地板 22.13 只考虑了 node:sqlite,但 rc.6 的
 *   session-persistence-jsonl 还 import 了 node:zlib 的 zstd API(22.15 才加入),
 *   真机上系统 node 22.14 通过旧检查 → 启动即崩:createZstdDecompress 缺失。
 * - 23.x 不在 engines 内(非 LTS,且 23.0–23.7 同样没有 zstd)。
 */
export const DSH_NODE_FLOOR = { major: 22, minor: 19 } as const
/** engines 上限侧:22 与 24 之间无合法 major。 */
const DSH_NODE_MIN_HIGHER_MAJOR = 24

export function satisfiesNodeFloor(
  version: string,
  floor: { readonly major: number; readonly minor: number } = DSH_NODE_FLOOR
): boolean {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!match || match[1] === undefined || match[2] === undefined) {
    return false
  }
  const major = Number.parseInt(match[1], 10)
  const minor = Number.parseInt(match[2], 10)
  if (major === floor.major) {
    return minor >= floor.minor
  }
  return major >= DSH_NODE_MIN_HIGHER_MAJOR
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
  /** 内置真 node.exe(仅 Windows 有物化);在位时最优先,理由见下。 */
  readonly bundledNode?: BundledNodeSpec | null
  readonly exists?: (p: string) => boolean
  readonly nodeVersion?: (nodePath: string) => string | null
}): NodeExecResolution {
  // 0) 内置真 node.exe 最优先(Windows)。为什么压过系统 node:真 Node 22 是
  // 我们锁定并验证过 koffi.view 的运行时,不允许任何一台机器再落到 Electron
  // 内嵌 Node 上——那个运行时下 koffi.view 原生崩溃,win32 目录选择 worker
  // 静默死亡(本机 A/B 实测;koffi 3.1.5/3.2.1 无差别)。内置 DSH 树全是
  // napi 预编译包,无 ABI 顾虑。
  if (input.bundledNode && satisfiesNodeFloor(input.bundledNode.version)) {
    return {
      exec: input.bundledNode.exec,
      useRunAsNode: false,
      source: 'bundled',
      nodeFlags: [],
      reason: `使用内置 node.exe ${input.bundledNode.version}(Electron 内嵌 Node 下 koffi.view 原生崩溃,win32 目录选择需要真 Node)`
    }
  }
  // 1) 系统 node:npm 安装的原生模块(node-pty / node-addon-require-builtin)
  // 按系统 node ABI 编译,天然匹配;Electron 内嵌 Node 的 ABI 不同,会踩坑。
  // 但系统 node 必须满足 DSH engines 地板(^22.19||>=24),否则缺 API
  // (如 22.14 缺 node:zlib zstd)会让 DSH 启动即崩 → 继续往下回落。
  const probeVersion = input.nodeVersion ?? systemNodeVersion
  const systemNode = findSystemNode(input.envPath, input.exists)
  let systemVersion: string | null = null
  if (systemNode) {
    const version = probeVersion(systemNode)
    systemVersion = version
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
      reason: `系统 node ${
        systemNode ? `${systemNode} ${systemVersion ?? ''}不满足 DSH 地板(^22.19||>=24)` : '未找到'
      },使用 Electron 内嵌 Node ${input.electronNodeVersion}(+--expose-internals)`
    }
  }
  throw new Error(
    `未找到满足 DSH 要求(engines ^22.19||>=24)的运行时:Electron 内嵌 ${input.electronNodeVersion}` +
      (systemNode ? ',系统 node 版本过低' : ',且未找到系统 node')
  )
}

/** 内置 node 运行时 manifest(fetch 脚本写入;缺失/损坏一律视为不存在)。 */
const bundledNodeManifestSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  installedAt: z.number().int().positive()
})

/**
 * 读取内置 node.exe(仅 win32;dev 未物化或 packaged 缺文件时返回 null,
 * 解析链自然回落系统/Electron node,绝不因此抛错)。
 */
export function readBundledNode(
  bundledNodeRoot: string,
  platform: NodeJS.Platform = process.platform
): BundledNodeSpec | null {
  if (platform !== 'win32') return null
  const exec = join(bundledNodeRoot, 'node.exe')
  try {
    accessSync(exec, constants.X_OK)
    const manifest = bundledNodeManifestSchema.parse(
      JSON.parse(readFileSync(join(bundledNodeRoot, '.node-runtime.json'), 'utf8'))
    )
    return { exec, version: manifest.version }
  } catch {
    return null
  }
}
