/**
 * 主窗口:壳本地视图(loading/error)与 DSH Web UI 之间的三态切换。
 * close → preventDefault + hide(后台常驻语义);真正退出由 main.ts 的
 * before-quit 序列驱动(quitting 标志)。
 */

import { BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { getLogger } from '../logger'

const log = getLogger('main-window')

export type ShellView = 'loading' | 'error' | 'setup'

export interface MainWindowDeps {
  readonly devServerUrl: string | null
  readonly rendererDistDir: string
  readonly preloadPath: string
  readonly initialBounds: { readonly width: number; readonly height: number }
  readonly onManageRequested: () => void
  readonly onBoundsChanged: (bounds: { width: number; height: number; x: number | null; y: number | null }) => void
}

export class MainWindowController {
  private readonly window: BrowserWindow
  private quitting = false
  private currentView: ShellView | 'dsh' = 'loading'
  private currentDshUrl: string | null = null

  constructor(private readonly deps: MainWindowDeps) {
    this.window = new BrowserWindow({
      width: deps.initialBounds.width,
      height: deps.initialBounds.height,
      show: false,
      title: 'DSH GUI',
      autoHideMenuBar: true,
      webPreferences: {
        preload: deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false
      }
    })
    this.window.on('close', (event) => {
      if (!this.quitting) {
        event.preventDefault()
        this.window.hide()
      }
    })
    this.window.on('resize', () => this.reportBounds())
    this.window.on('move', () => this.reportBounds())
    // 外链走系统浏览器,DSH 页面里的 target=_blank 不开新 Electron 窗
    this.window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('http://127.0.0.1:')) {
        return { action: 'allow' }
      }
      void shell.openExternal(url)
      return { action: 'deny' }
    })
    this.window.webContents.on('did-fail-load', (_event, code, description, url) => {
      if (url.startsWith('http://127.0.0.1:')) {
        log.warn('DSH page failed to load', { code, description, url })
        this.showShellView('error')
      }
    })
  }

  setQuitting(quitting: boolean): void {
    this.quitting = quitting
  }

  show(): void {
    this.window.show()
    this.window.focus()
  }

  isWindowVisible(): boolean {
    return this.window.isVisible() && !this.window.isMinimized()
  }

  showShellView(view: ShellView): void {
    if (this.currentView === view && this.window.webContents.getURL().includes(`#${view}`)) {
      return
    }
    this.currentView = view
    this.currentDshUrl = null
    const devUrl = this.deps.devServerUrl
    if (devUrl) {
      void this.window.loadURL(`${devUrl}/#${view}`)
    } else {
      void this.window.loadFile(join(this.deps.rendererDistDir, 'index.html'), { hash: view })
    }
  }

  loadDsh(url: string): void {
    if (this.currentView === 'dsh' && this.currentDshUrl === url) {
      return
    }
    this.currentView = 'dsh'
    this.currentDshUrl = url
    log.info('loading DSH Web UI', { url })
    void this.window.loadURL(url)
  }

  /** DSH 重启后端口变化时:清掉陈旧页面。 */
  resetToLoading(): void {
    this.showShellView('loading')
  }

  getWindow(): BrowserWindow {
    return this.window
  }

  private reportTimer: NodeJS.Timeout | null = null

  private reportBounds(): void {
    if (this.reportTimer) {
      clearTimeout(this.reportTimer)
    }
    this.reportTimer = setTimeout(() => {
      this.reportTimer = null
      if (this.window.isDestroyed()) {
        return
      }
      const bounds = this.window.getBounds()
      this.deps.onBoundsChanged({
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y
      })
    }, 500)
  }
}
