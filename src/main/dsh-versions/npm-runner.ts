/**
 * npm 调用:唯一入口。探测系统 npm(PATH + 常见安装位),统一解析成
 * `node npm-cli.js …` 形式执行(Windows 的 npm.cmd 不能被 spawn 直接拉起;
 * 跨平台都用 Electron-as-Node 跑纯 JS 的 npm-cli)。
 * 接口化 —— 将来若改为捆绑 npm-cli,只换本文件实现。
 */

import { execFile, spawn } from 'node:child_process'
import { accessSync, constants, realpathSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'
import type { Result } from '../../shared/contracts'
import { err, errFromUnknown, ok } from '../util/result'
import type { NpmRunner } from './contracts'

const NPM_PACKAGE = '@deepseek-ai/dsh'
const NPM_TAIL_LINES = 50

export interface NpmLookupSpec {
  readonly delimiter: string
  readonly names: readonly string[]
  readonly extraPaths: readonly string[]
}

export function defaultNpmLookupSpec(platform: NodeJS.Platform = process.platform): NpmLookupSpec {
  return platform === 'win32'
    ? {
        delimiter: ';',
        names: ['npm.cmd', 'npm'],
        extraPaths: ['C:\\Program Files\\nodejs\\npm.cmd']
      }
    : {
        delimiter: ':',
        names: ['npm'],
        extraPaths: ['/opt/homebrew/bin/npm', '/usr/local/bin/npm']
      }
}

function defaultExists(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function findNpm(
  envPath: string,
  exists: (p: string) => boolean = defaultExists,
  spec: NpmLookupSpec = defaultNpmLookupSpec()
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

/** 解析出可直接 spawn 的调用:nodeExec + [npm-cli.js, …]。 */
export interface NpmInvocation {
  readonly exec: string
  readonly cliJs: string
  readonly env: Readonly<Record<string, string>>
}

export function resolveNpmInvocation(
  npmPath: string,
  nodeExec: string,
  exists: (p: string) => boolean = defaultExists
): NpmInvocation | null {
  const candidates = [
    join(dirname(npmPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    (() => {
      try {
        const real = realpathSync(npmPath)
        return real.endsWith('npm-cli.js') ? real : null
      } catch {
        return null
      }
    })()
  ]
  const cliJs = candidates.find((c): c is string => c !== null && exists(c))
  if (!cliJs) {
    return null
  }
  return {
    exec: nodeExec,
    cliJs,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  }
}

function execNpmText(
  invocation: NpmInvocation,
  args: readonly string[],
  timeoutMs = 30_000
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      invocation.exec,
      [invocation.cliJs, ...args],
      { encoding: 'utf8', timeout: timeoutMs, env: { ...invocation.env } },
      (error, stdout) => {
        if (error) {
          reject(error)
        } else {
          resolve(stdout)
        }
      }
    )
  })
}

export function createNpmRunner(npmPath: string, nodeExec: string): NpmRunner {
  const invocation = resolveNpmInvocation(npmPath, nodeExec)
  const unavailable = (method: string): Result<never> =>
    err('npm-unavailable', `无法把 ${npmPath} 解析为 npm-cli.js(${method});请确认已安装 Node.js`)

  return {
    async listRegistryVersions(): Promise<Result<readonly string[]>> {
      if (!invocation) {
        return unavailable('versions')
      }
      try {
        const stdout = await execNpmText(invocation, ['view', NPM_PACKAGE, 'versions', '--json'])
        const parsed: unknown = JSON.parse(stdout)
        if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== 'string')) {
          return err('npm-parse', 'npm versions 输出不是字符串数组')
        }
        return ok(parsed as readonly string[])
      } catch (error) {
        return errFromUnknown('npm-view-failed', error)
      }
    },

    async listDistTags(): Promise<Result<Readonly<Record<string, string>>>> {
      if (!invocation) {
        return unavailable('dist-tags')
      }
      try {
        const stdout = await execNpmText(invocation, ['view', NPM_PACKAGE, 'dist-tags', '--json'])
        const parsed: unknown = JSON.parse(stdout)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return err('npm-parse', 'npm dist-tags 输出不是对象')
        }
        const entries = Object.entries(parsed as Record<string, unknown>)
        if (entries.some(([, v]) => typeof v !== 'string')) {
          return err('npm-parse', 'npm dist-tags 值类型异常')
        }
        return ok(Object.fromEntries(entries) as Record<string, string>)
      } catch (error) {
        return errFromUnknown('npm-view-failed', error)
      }
    },

    installTo(
      prefixDir: string,
      version: string,
      onLine: (line: string) => void
    ): Promise<Result<null>> {
      if (!invocation) {
        return Promise.resolve(unavailable('install'))
      }
      return new Promise((resolve) => {
        const child = spawn(
          invocation.exec,
          [
            invocation.cliJs,
            'install',
            '--prefix',
            prefixDir,
            '--no-fund',
            '--no-audit',
            '--loglevel',
            'notice',
            `${NPM_PACKAGE}@${version}`
          ],
          { env: { ...invocation.env }, stdio: ['ignore', 'pipe', 'pipe'] }
        )
        const tail: string[] = []
        const collect = (line: string): void => {
          tail.push(line)
          if (tail.length > NPM_TAIL_LINES) {
            tail.shift()
          }
          onLine(line)
        }
        if (child.stdout) {
          createInterface({ input: child.stdout }).on('line', collect)
        }
        if (child.stderr) {
          createInterface({ input: child.stderr }).on('line', collect)
        }
        child.on('error', (error) => {
          resolve(err('npm-spawn-failed', error.message))
        })
        child.on('exit', (code) => {
          if (code === 0) {
            resolve(ok(null))
          } else {
            resolve(err('npm-install-failed', `npm install 退出码 ${code ?? 'null'}\n${tail.join('\n')}`))
          }
        })
      })
    }
  }
}
