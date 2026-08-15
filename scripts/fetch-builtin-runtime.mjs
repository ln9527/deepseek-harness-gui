#!/usr/bin/env node
/**
 * 物化随安装包内置的 DSH 运行时树到 resources/dsh-runtime/<version>/。
 * - 树必须来自 npm 布局(真实目录 + node_modules/.bin 符号链接;禁止 pnpm .pnpm 农场)
 * - 已存在且校验通过时幂等跳过(不重复下载)
 * - dist 脚本自动调用;也可手动 pnpm fetch:runtime
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PINNED_DSH_VERSION = '0.1.0-rc.6'
const NPM_PACKAGE = '@deepseek-ai/dsh'

// --platform win32:为 Windows 物化 win32-x64 树(--os/--cpu 选择平台预编译包;
// --ignore-scripts 跳过 koffi 的本机 cmake 编译,平台预编译包在运行时直接加载)
const targetPlatform = process.argv.includes('--platform') ? process.argv[process.argv.indexOf('--platform') + 1] : process.platform
const isWin = targetPlatform === 'win32'
const runtimeDirName = isWin ? 'dsh-runtime-win' : 'dsh-runtime'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const versionsRoot = join(root, 'resources', runtimeDirName)
const targetDir = join(versionsRoot, PINNED_DSH_VERSION)
const entryRelative = join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const manifestPath = join(targetDir, '.dsh-manifest.json')
const npmPlatformFlags = isWin ? ['--os=win32', '--cpu=x64', '--ignore-scripts'] : []

function manifestOk() {
  if (!existsSync(manifestPath) || !existsSync(join(targetDir, entryRelative))) {
    return false
  }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    return manifest.version === PINNED_DSH_VERSION
  } catch {
    return false
  }
}

if (manifestOk()) {
  console.log(`builtin runtime ${runtimeDirName}/${PINNED_DSH_VERSION} already materialized, skip`)
  process.exit(0)
}

// npm 布局断言:入口在、.bin 存在、无 .pnpm;win 树另需关键平台预编译包
function assertNpmLayout(dir) {
  if (!existsSync(join(dir, entryRelative))) {
    throw new Error(`entry missing: ${join(dir, entryRelative)}`)
  }
  if (!existsSync(join(dir, 'node_modules', '.bin'))) {
    throw new Error('node_modules/.bin missing — tree is not a npm-layout install')
  }
  if (existsSync(join(dir, 'node_modules', '.pnpm'))) {
    throw new Error('.pnpm directory found — pnpm symlink farm cannot be embedded; use npm install')
  }
  if (isWin) {
    const win32Pkgs = [
      'node_modules/@koromix/koffi-win32-x64',
      'node_modules/@img/sharp-win32-x64',
      'node_modules/node-addon-require-builtin-win32-x64-msvc',
      'node_modules/node-pty/prebuilds/win32-x64'
    ]
    for (const pkg of win32Pkgs) {
      if (!existsSync(join(dir, pkg))) {
        throw new Error(`win32-x64 component missing: ${pkg}`)
      }
    }
  }
}

mkdirSync(versionsRoot, { recursive: true })
const tmpDir = join(versionsRoot, `tmp-${PINNED_DSH_VERSION}-${Date.now()}`)
console.log(`npm install ${NPM_PACKAGE}@${PINNED_DSH_VERSION} → ${tmpDir}${isWin ? ' (win32-x64)' : ''}`)
execFileSync(
  'npm',
  [
    'install',
    '--prefix',
    tmpDir,
    '--no-fund',
    '--no-audit',
    '--omit=dev',
    '--loglevel',
    'notice',
    ...npmPlatformFlags,
    `${NPM_PACKAGE}@${PINNED_DSH_VERSION}`
  ],
  { stdio: 'inherit' }
)
assertNpmLayout(tmpDir)
const [major, minor] = process.versions.node.split('.')
writeFileSync(
  join(tmpDir, '.dsh-manifest.json'),
  `${JSON.stringify(
    {
      version: PINNED_DSH_VERSION,
      installedAt: Date.now(),
      entryPath: entryRelative,
      nodeMajorMinor: `${major}.${minor}`
    },
    null,
    2
  )}\n`,
  'utf8'
)
if (existsSync(targetDir)) {
  renameSync(targetDir, `${targetDir}.old-${Date.now()}`)
}
renameSync(tmpDir, targetDir)
console.log(`builtin runtime ready: ${targetDir}`)
