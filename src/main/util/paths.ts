/**
 * 路径解析:所有磁盘位置的唯一出处(dev 与 packaged 两种形态)。
 * 纯函数,便于测试。
 */

import { join } from 'node:path'

export interface StoragePaths {
  readonly userDataDir: string
  readonly versionsRoot: string
  readonly settingsPath: string
  readonly resourceRoot: string
  readonly trayIconDir: string
  /** 随安装包内置的 DSH 运行时树(packaged: Resources/resources/dsh-runtime)。 */
  readonly builtinRuntimeRoot: string
}

export function resolveStoragePaths(input: {
  readonly userDataDir: string
  readonly isPackaged: boolean
  readonly appPath: string
  readonly resourcesPath: string
}): StoragePaths {
  const resourceRoot = input.isPackaged
    ? join(input.resourcesPath, 'resources')
    : join(input.appPath, 'resources')
  return {
    userDataDir: input.userDataDir,
    versionsRoot: join(input.userDataDir, 'versions'),
    settingsPath: join(input.userDataDir, 'settings.json'),
    resourceRoot,
    trayIconDir: join(resourceRoot, 'tray'),
    builtinRuntimeRoot: join(resourceRoot, builtinRuntimeDirName())
  }
}

/** 内置运行时目录名:按平台物化(mac: dsh-runtime / win: dsh-runtime-win)。 */
export function builtinRuntimeDirName(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? 'dsh-runtime-win' : 'dsh-runtime'
}

/** 某版本安装树内 DSH 入口的相对路径(npm --prefix 安装布局)。 */
export function dshEntryRelativePath(): string {
  return join('node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}
