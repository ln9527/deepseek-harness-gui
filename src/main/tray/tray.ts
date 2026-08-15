/**
 * 系统托盘:两态图标 + 菜单。退出 DSH GUI 的主要入口(优雅关停)。
 * 图标为 Template Image(黑 + alpha,命名 *Template.png),缺失时降级为空图标。
 */

import { Menu, nativeImage, Tray } from 'electron'
import { join } from 'node:path'
import type { DshRuntimeSnapshot } from '../../shared/contracts'
import type { ShellSettings } from '../../shared/settings'
import { getLogger } from '../logger'

const log = getLogger('tray')

export interface TrayDeps {
  readonly iconDir: string
  readonly onShowMain: () => void
  readonly onOpenManage: () => void
  readonly onRestart: () => void
  readonly onStop: () => void
  readonly onQuit: () => void
  readonly onToggleAutoLaunch: (enabled: boolean) => void
  readonly onToggleOnlyWhenHidden: (enabled: boolean) => void
}

export class TrayController {
  private readonly tray: Tray
  private snapshot: DshRuntimeSnapshot | null = null
  private settings: ShellSettings | null = null

  constructor(private readonly deps: TrayDeps) {
    this.tray = new Tray(this.loadIcon('stopped'))
    this.tray.setToolTip('DSH GUI')
    this.rebuild()
  }

  update(snapshot: DshRuntimeSnapshot, settings: ShellSettings): void {
    this.snapshot = snapshot
    this.settings = settings
    const iconKey = snapshot.state === 'ready' ? 'ready' : 'stopped'
    this.tray.setImage(this.loadIcon(iconKey))
    this.rebuild()
  }

  destroy(): void {
    this.tray.destroy()
  }

  private rebuild(): void {
    const snap = this.snapshot
    const settings = this.settings
    const statusText =
      snap === null
        ? 'DSH GUI'
        : snap.state === 'ready'
          ? `DSH 就绪 · ${snap.version ?? '?'} · :${snap.port ?? '?'}`
          : snap.state === 'starting' || snap.state === 'restarting'
            ? `DSH 启动中…(第 ${snap.restartAttempt} 次尝试)`
            : snap.state === 'stopping'
              ? 'DSH 停止中…'
              : snap.state === 'stopped'
                ? snap.lastError ? 'DSH 已停止(出错)' : 'DSH 已停止'
                : 'DSH 待启动'
    const running = snap?.state === 'ready' || snap?.state === 'starting' || snap?.state === 'restarting'
    const menu = Menu.buildFromTemplate([
      { label: statusText, enabled: false },
      { type: 'separator' },
      { label: '打开 DSH', click: () => this.deps.onShowMain() },
      { label: '管理…', click: () => this.deps.onOpenManage() },
      { type: 'separator' },
      { label: '重启后端', enabled: running, click: () => this.deps.onRestart() },
      { label: '停止后端', enabled: running, click: () => this.deps.onStop() },
      { type: 'separator' },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: settings?.launch.openAtLogin ?? false,
        click: (item) => this.deps.onToggleAutoLaunch(item.checked)
      },
      {
        label: '通知:仅后台时提醒',
        type: 'checkbox',
        checked: settings?.notifications.onlyWhenHidden ?? true,
        click: (item) => this.deps.onToggleOnlyWhenHidden(item.checked)
      },
      { type: 'separator' },
      { label: '退出 DSH GUI', click: () => this.deps.onQuit() }
    ])
    this.tray.setContextMenu(menu)
  }

  private loadIcon(kind: 'ready' | 'stopped'): Electron.NativeImage {
    // macOS 用 Template Image(系统着色);Windows 用彩色普通 png
    const files =
      process.platform === 'win32'
        ? [`win-${kind}.png`]
        : [`${kind}Template@2x.png`, `${kind}Template.png`]
    for (const file of files) {
      const image = nativeImage.createFromPath(join(this.deps.iconDir, file))
      if (!image.isEmpty()) {
        return image
      }
    }
    log.warn('tray icon missing, using empty image', { kind, dir: this.deps.iconDir })
    return nativeImage.createEmpty()
  }
}
