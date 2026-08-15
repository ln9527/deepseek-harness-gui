/**
 * 开机自启 + 启动参数。App Translocation 检测:未拷入 /Applications 而从
 * Downloads 等隔离位置运行时,login item 路径会漂移导致自启失效。
 */

import { app } from 'electron'

export function syncLoginItem(openAtLogin: boolean, startHidden: boolean): void {
  app.setLoginItemSettings({
    openAtLogin,
    openAsHidden: false,
    args: startHidden ? ['--hidden'] : []
  })
}

export function parseHiddenFlag(argv: readonly string[]): boolean {
  return argv.includes('--hidden')
}

export function isTranslocated(): boolean {
  return process.execPath.includes('AppTranslocation')
}
