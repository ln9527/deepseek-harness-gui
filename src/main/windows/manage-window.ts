/**
 * 管理窗口:单例小窗(版本面板 / 设置 / 日志 / 关于)。
 * 与主窗口物理隔离 —— 壳 UI 与上游 Web UI 互不注入。
 */

import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { getLogger } from '../logger'

const log = getLogger('manage-window')

export interface ManageWindowDeps {
  readonly devServerUrl: string | null
  readonly rendererDistDir: string
  readonly preloadPath: string
}

export type ManageTab = 'versions' | 'settings' | 'logs' | 'about'

export class ManageWindowController {
  private window: BrowserWindow | null = null
  private quitting = false

  constructor(private readonly deps: ManageWindowDeps) {}

  setQuitting(quitting: boolean): void {
    this.quitting = quitting
    if (quitting && this.window) {
      this.window.close()
    }
  }

  /** 打开管理窗;可指定定位 tab(已开时重新路由到该 tab)。 */
  open(tab?: ManageTab): void {
    const hash = tab !== undefined ? `manage/${tab}` : 'manage'
    if (this.window && !this.window.isDestroyed()) {
      this.loadRoute(hash)
      this.window.show()
      this.window.focus()
      return
    }
    this.window = new BrowserWindow({
      width: 760,
      height: 600,
      show: false,
      title: 'DSH GUI 管理',
      autoHideMenuBar: true,
      resizable: true,
      webPreferences: {
        preload: this.deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    this.window.on('close', (event) => {
      if (!this.quitting) {
        event.preventDefault()
        this.window?.hide()
      }
    })
    this.loadRoute(hash)
    this.window.once('ready-to-show', () => {
      log.info('manage window opened', { hash })
      this.window?.show()
      this.window?.focus()
    })
  }

  private loadRoute(hash: string): void {
    const devUrl = this.deps.devServerUrl
    if (devUrl) {
      void this.window?.loadURL(`${devUrl}/#${hash}`)
    } else {
      void this.window?.loadFile(join(this.deps.rendererDistDir, 'index.html'), { hash })
    }
  }
}
