/**
 * main 进程编排:单实例锁 → logger → 设置 → node 运行时解析 → 版本注册表 →
 * supervisor / 通知桥 / 窗口 / 托盘 / IPC → before-quit 优雅关停。
 */

import { app, dialog, Notification, safeStorage, shell } from 'electron'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { mkdirSync } from 'node:fs'
import type { DshRuntimeSnapshot, DshSpawnContract, Result } from '../shared/contracts'
import { getLogger, initLogger } from './logger'
import { resolveStoragePaths } from './util/paths'
import { ok } from './util/result'
import { SettingsStore } from './settings/store'
import { syncLoginItem, parseHiddenFlag, isTranslocated } from './auto-launch'
import { realChildProcessFactory } from './dsh-runtime/child-process'
import { readBundledNode, resolveNodeExec, type NodeExecResolution } from './dsh-runtime/node-exec'
import { DshRuntimeSupervisor } from './dsh-runtime/supervisor'
import { createNpmRunner, findNpm } from './dsh-versions/npm-runner'
import type { InstalledVersion } from './dsh-versions/contracts'
import { resolveActiveVersion, scanBuiltinVersions, scanInstalledVersions } from './dsh-versions/registry'
import { VersionInstaller } from './dsh-versions/installer'
import { checkForUpdate } from './dsh-versions/update-checker'
import { shouldPromptApiKey } from './deepseek/api-key'
import { NotifyBridge, sessionCookieName } from './notify-bridge/bridge'
import { DshNotifier } from './notify-bridge/notifier'
import { MainWindowController } from './windows/main-window'
import { ManageWindowController } from './windows/manage-window'
import { TrayController } from './tray/tray'
import { broadcastInstallProgress, broadcastSettings, broadcastSnapshot, registerIpc } from './ipc/register'
import { DesktopAuthClient } from './desktop-auth/client'
import { DesktopCredentialStore } from './desktop-auth/credential-store'
import { DesktopAuthService } from './desktop-auth/service'

declare const __DSH_GUI_TEST_VARIANT__: boolean
declare const __DSH_GUI_GATEWAY_ORIGIN__: string

let focusMain: (() => void) | null = null

function bootstrap(): void {
  const appTitle = __DSH_GUI_TEST_VARIANT__ ? 'DSH GUI Test' : 'DSH GUI'
  if (__DSH_GUI_TEST_VARIANT__) {
    app.setName(appTitle)
    const testUserData = join(app.getPath('appData'), 'DSH GUI Test')
    mkdirSync(testUserData, { recursive: true })
    app.setPath('userData', testUserData)
    app.setAppLogsPath(join(testUserData, 'logs'))
  }
  // Windows toast 通知需要稳定的 AppUserModelId
  if (process.platform === 'win32') {
    app.setAppUserModelId(__DSH_GUI_TEST_VARIANT__ ? 'com.ningli.dshgui.test' : 'com.ningli.dshgui')
  }
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
    return
  }
  const startHidden = parseHiddenFlag(process.argv)

  app.on('second-instance', () => {
    focusMain?.()
  })

  void app.whenReady().then(() => {
    const paths = resolveStoragePaths({
      userDataDir: app.getPath('userData'),
      isPackaged: app.isPackaged,
      appPath: app.getAppPath(),
      resourcesPath: process.resourcesPath
    })
    initLogger(app.getPath('logs'))
    const log = getLogger('main')
    log.info('booting', { version: app.getVersion(), electron: process.versions.electron, node: process.versions.node })

    // 全局兜底:未捕获异常记录日志并保活(托盘壳崩溃会把 DSH 子进程变成孤儿),
    // 附加监听器同时抑制 Electron 的崩溃对话框;问题仍会出现在「管理 → 日志」里。
    process.on('uncaughtException', (error) => {
      log.error('uncaughtException(已记录,进程保活)', {
        name: error.name,
        message: error.message,
        stack: error.stack ?? ''
      })
    })
    process.on('unhandledRejection', (reason) => {
      log.error('unhandledRejection(已记录)', {
        reason:
          reason instanceof Error
            ? `${reason.name}: ${reason.message}\n${reason.stack ?? ''}`
            : String(reason)
      })
    })

    // ---- Node 运行时(DSH engines ^22.19||>=24;内置真 node.exe → 系统 node → 内嵌) ----
    let nodeExec: NodeExecResolution
    try {
      nodeExec = resolveNodeExec({
        electronExecPath: process.execPath,
        electronNodeVersion: process.versions.node,
        envPath: process.env.PATH ?? '',
        // Windows 专属:随安装包内置的真 node.exe。Electron 内嵌 Node(24.x)下
        // koffi.view 原生崩溃,DSH 的 win32 目录选择 worker 会静默死亡
        // (「win32 folder dialog worker exited before reporting a result」)。
        bundledNode: readBundledNode(paths.bundledNodeRoot)
      })
      log.info('node exec resolved', { source: nodeExec.source, reason: nodeExec.reason })
    } catch (error) {
      dialog.showErrorBox(
        'DSH GUI 无法启动',
        `未找到满足 DSH 要求的 Node 运行时(engines ^22.19||>=24):\n${error instanceof Error ? error.message : String(error)}\n\n建议安装 Node.js 22 LTS 最新版(nodejs.org)后重试。`
      )
      app.quit()
      return
    }

    // ---- 设置 / 版本注册表 ----
    const settingsStore = new SettingsStore(paths.settingsPath)
    const npmPath = findNpm(process.env.PATH ?? '')
    if (npmPath === null) {
      log.warn('npm not found on PATH —— 版本安装/升级不可用(内置/已安装版本仍可运行)')
    }
    const npmRunner = createNpmRunner(npmPath ?? 'npm', nodeExec.exec)

    let activeInstalled: InstalledVersion | null = resolveActiveVersion(
      scanInstalledVersions(paths.versionsRoot),
      scanBuiltinVersions(paths.builtinRuntimeRoot),
      settingsStore.get().pinnedVersion
    )

    const buildSpawnContract = (): DshSpawnContract | null => {
      const target = activeInstalled
      if (target === null) {
        return null
      }
      const settings = settingsStore.get()
      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
          env[key] = value
        }
      }
      if (nodeExec.useRunAsNode) {
        env.ELECTRON_RUN_AS_NODE = '1'
      } else {
        delete env.ELECTRON_RUN_AS_NODE
      }
      if (settings.runtime.dshHomeOverride !== null) {
        env.DSH_HOME = settings.runtime.dshHomeOverride
      }
      for (const [key, value] of Object.entries(settings.runtime.extraEnv)) {
        env[key] = value
      }
      return {
        nodeExec: nodeExec.exec,
        entryPath: target.entryPath,
        args: [
          ...nodeExec.nodeFlags,
          target.entryPath,
          'web',
          '--host', '127.0.0.1',
          '--port', '0',
          // 0.1.5 起就绪后会唤起系统默认浏览器;壳自带窗口,必须关掉
          '--no-open'
        ],
        env,
        cwd: app.getPath('home')
      }
    }

    // ---- 窗口 ----
    const devServerUrl = process.env.ELECTRON_RENDERER_URL ?? null
    const rendererDistDir = join(app.getAppPath(), 'out/renderer')
    const preloadPath = join(__dirname, '../preload/index.js')
    const initialWindow = settingsStore.get().window

    const mainWindow = new MainWindowController({
      devServerUrl,
      rendererDistDir,
      preloadPath,
      appTitle,
      initialBounds: { width: initialWindow.width, height: initialWindow.height },
      onManageRequested: () => manageWindow.open(),
      onBoundsChanged: (bounds) => {
        settingsStore.update({ window: bounds })
      }
    })
    const manageWindow = new ManageWindowController({ devServerUrl, rendererDistDir, preloadPath, appTitle })
    focusMain = () => mainWindow.show()

    const desktopAuth = new DesktopAuthService({
      client: new DesktopAuthClient(__DSH_GUI_GATEWAY_ORIGIN__),
      store: new DesktopCredentialStore(join(paths.userDataDir, 'desktop-credential.bin'), safeStorage, __DSH_GUI_GATEWAY_ORIGIN__),
      openExternal: (url) => shell.openExternal(url),
      deviceName: `${appTitle} (${process.platform === 'win32' ? 'Windows' : 'macOS'}) · ${hostname().slice(0, 48)}`,
      onState: (state) => manageWindow.sendDesktopAuth(state)
    })
    void desktopAuth.refresh()

    // ---- 通知桥 ----
    const bridge = new NotifyBridge({
      cookieProvider: async (port) => {
        const origin = `http://127.0.0.1:${port}`
        const currentUrl = mainWindow.getWindow().webContents.getURL()
        // A stored cookie alone is insufficient: wait until this window has
        // completed the launch-token redirect to the clean DSH page.
        try {
          const page = new URL(currentUrl)
          if (page.origin !== origin || page.searchParams.has('token')) return null
        } catch { return null }
        const name = sessionCookieName(port)
        const cookies = await mainWindow.getWindow().webContents.session.cookies.get({
          url: `${origin}/`, name
        })
        const cookie = cookies.find((item) => item.name === name && item.httpOnly)
        return cookie === undefined ? null : `${name}=${cookie.value}`
      }
    })
    const notifier = new DshNotifier({
      getSettings: () => settingsStore.get().notifications,
      isMainWindowVisible: () => mainWindow.isWindowVisible(),
      isNotificationSupported: () => Notification.isSupported(),
      onFocusRequested: () => mainWindow.show()
    })
    bridge.onSignal((signal) => notifier.handleSignal(signal))
    bridge.onConnectedChange((connected) => supervisor.setBridgeConnected(connected))

    // ---- supervisor ----
    /** 就绪行解析出的完整本机 URL(含 ?token=…),每次启动覆盖。 */
    let lastReadyUrl: string | null = null
    const supervisor = new DshRuntimeSupervisor(
      {
        childFactory: realChildProcessFactory,
        spawnContractProvider: buildSpawnContract,
        getAutoRestart: () => settingsStore.get().autoRestart
      },
      {
        onSnapshot: (snapshot) => {
          if (snapshot.state !== 'ready') bridge.detach()
          reconcileViews(snapshot)
          tray.update(snapshot, settingsStore.get())
          broadcastSnapshot(snapshot)
        },
        onReady: (port) => {
          log.info('DSH ready', { port })
          // 0.1.5 起 fence 要求 token:必须加载就绪行里的完整 URL,裸端口会显示
          // 「dsh web authentication required」。URL 缺失时退回裸端口(旧版兼容)。
          mainWindow.loadDsh(lastReadyUrl ?? `http://127.0.0.1:${port}`)
          bridge.attach(port)
          maybePromptForApiKey()
        },
        onReadyUrl: (url) => {
          lastReadyUrl = url
        },
        onCrashed: (error) => notifier.notifyCrashed(error)
      }
    )

    /** 首次就绪且无任何 API Key(环境变量与设置均无)时,弹一次引导去设置页。 */
    const maybePromptForApiKey = (): void => {
      const settings = settingsStore.get()
      if (!shouldPromptApiKey(process.env, settings.runtime.extraEnv, settings.flags)) {
        return
      }
      // 先落盘标志再弹窗:防 ready 重入/重启后重复打扰
      settingsStore.update({ flags: { apiKeyPromptSeen: true } })
      void dialog
        .showMessageBox(mainWindow.getWindow(), {
          type: 'info',
          message: '未检测到 DeepSeek API Key',
          detail:
            '要在 DSH 里使用 DeepSeek 模型,需要配置 API Key。\n' +
            '可以在本应用的「管理 → 设置」里直接填写,也可以稍后在 DSH Web UI 的 Models 页配置。',
          buttons: ['去设置', '稍后'],
          defaultId: 0,
          noLink: true
        })
        .then((choice) => {
          if (choice.response === 0) {
            manageWindow.open('settings')
          }
        })
    }

    // ---- 视图收敛:无版本→setup;ready→DSH(onReady 驱动);stopped→error;其余 loading ----
    const reconcileViews = (snapshot: DshRuntimeSnapshot): void => {
      if (activeInstalled === null) {
        mainWindow.showShellView('setup')
        return
      }
      if (snapshot.state === 'ready') {
        return // loadDsh 由 onReady 驱动
      }
      if (snapshot.state === 'stopped') {
        mainWindow.showShellView('error')
        return
      }
      mainWindow.showShellView('loading')
    }

    // ---- 安装器 ----
    const installer = new VersionInstaller({
      npm: npmRunner,
      versionsRoot: paths.versionsRoot,
      nodeMajorMinor: process.versions.node.split('.').slice(0, 2).join('.'),
      getActiveVersion: () => supervisor.snapshot().version,
      isBuiltinVersion: (version) =>
        scanBuiltinVersions(paths.builtinRuntimeRoot).some((b) => b.version === version),
      onInstalled: () => {
        refreshTarget()
        const state = supervisor.snapshot()
        if (state.state === 'idle' || state.state === 'stopped') {
          supervisor.start()
        }
      },
      onRemoved: () => {
        refreshTarget()
      }
    })
    installer.onProgress(broadcastInstallProgress)

    const refreshTarget = (): void => {
      activeInstalled = resolveActiveVersion(
        scanInstalledVersions(paths.versionsRoot),
        scanBuiltinVersions(paths.builtinRuntimeRoot),
        settingsStore.get().pinnedVersion
      )
      supervisor.setVersion(activeInstalled?.version ?? null)
      reconcileViews(supervisor.snapshot())
      tray.update(supervisor.snapshot(), settingsStore.get())
    }

    // ---- 托盘 ----
    const tray = new TrayController({
      iconDir: paths.trayIconDir,
      onShowMain: () => mainWindow.show(),
      onOpenManage: () => manageWindow.open(),
      onRestart: () => {
        void supervisor.restartNow()
      },
      onStop: () => {
        void supervisor.stop()
      },
      onQuit: () => requestQuit(),
      onToggleAutoLaunch: (enabled) => {
        settingsStore.update({ launch: { openAtLogin: enabled } })
      },
      onToggleOnlyWhenHidden: (enabled) => {
        settingsStore.update({ notifications: { onlyWhenHidden: enabled } })
      }
    })

    // ---- 退出序列(托盘/Cmd+Q/error 页共同入口) ----
    let quitting = false
    const requestQuit = (): void => {
      if (quitting) {
        return
      }
      quitting = true
      mainWindow.setQuitting(true)
      manageWindow.setQuitting(true)
      bridge.detach()
      desktopAuth.dispose()
      void (async () => {
        await supervisor.stop()
        supervisor.dispose()
        app.exit(0)
      })()
      setTimeout(() => {
        app.exit(0) // 兜底:关停序列卡死也保证退出
      }, 8000)
    }
    app.on('before-quit', (event) => {
      event.preventDefault()
      requestQuit()
    })

    // 外部信号(kill、终端关闭)汇入同一条优雅退出序列,防 DSH 子进程泄漏
    for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
      process.on(signal, () => {
        requestQuit()
      })
    }

    // ---- IPC ----
    registerIpc({
      supervisor,
      installer,
      settingsStore,
      npmRunner,
      versionsRoot: paths.versionsRoot,
      builtinRuntimeRoot: paths.builtinRuntimeRoot,
      desktopAuth,
      actions: {
        quit: () => requestQuit(),
        openManage: () => manageWindow.open(),
        openLogsFolder: () => {
          void shell.openPath(app.getPath('logs'))
        },
        getActiveVersion: () => supervisor.snapshot().version,
        isManageWebContents: (senderId) => manageWindow.ownsWebContents(senderId),
        selectVersion: (version: string): Result<null> => {
          settingsStore.update({ pinnedVersion: version })
          refreshTarget()
          void supervisor.restartNow()
          return ok(null)
        }
      }
    })

    // ---- 设置联动 ----
    settingsStore.subscribe((settings) => {
      broadcastSettings(settings)
      tray.update(supervisor.snapshot(), settings)
      syncLoginItem(settings.launch.openAtLogin, settings.launch.startHidden)
    })

    // ---- 启动 ----
    supervisor.setVersion(activeInstalled?.version ?? null)
    tray.update(supervisor.snapshot(), settingsStore.get())
    syncLoginItem(settingsStore.get().launch.openAtLogin, settingsStore.get().launch.startHidden)
    if (isTranslocated()) {
      log.warn('检测到 App Translocation:应用正从隔离路径运行,开机自启会失效,请将 DSH GUI 拖入 /Applications')
    }
    reconcileViews(supervisor.snapshot())
    mainWindow.getWindow().once('ready-to-show', () => {
      if (!startHidden) {
        mainWindow.show()
      }
    })
    if (activeInstalled !== null) {
      supervisor.start()
    } else {
      log.info('no DSH version installed —— 进入首装向导')
    }

    // ---- DSH 新版本检测(默认只提醒;设置开启 autoInstall 后自动安装并切换) ----
    const applyUpdate = (latest: string): void => {
      settingsStore.update({ pinnedVersion: latest })
      refreshTarget()
      void supervisor.restartNow()
    }
    const scheduleUpdateCheck = (): void => {
      if (!settingsStore.get().updates.autoCheck) {
        return
      }
      void checkForUpdate({
        npm: npmRunner,
        activeVersion: activeInstalled?.version ?? null,
        channel: settingsStore.get().updates.channel
      }).then((result) => {
        if (!result.ok || !result.value.updateAvailable) {
          return
        }
        const latest = result.value.latest
        log.info('DSH update available', { latest, current: result.value.current })
        if (!settingsStore.get().updates.autoInstall) {
          if (Notification.isSupported()) {
            new Notification({
              title: '发现 DSH 新版本',
              body: `${latest} 已发布,打开「管理 → 版本」即可一键更新。`
            }).show()
          }
          return
        }
        if (installer.isBusy()) {
          return
        }
        const known =
          scanInstalledVersions(paths.versionsRoot).some((v) => v.version === latest) ||
          scanBuiltinVersions(paths.builtinRuntimeRoot).some((v) => v.version === latest)
        if (known) {
          applyUpdate(latest)
          return
        }
        const started = installer.start(latest)
        if (!started.ok) {
          return
        }
        const off = installer.onProgress((progress) => {
          if (progress.version !== latest) {
            return
          }
          if (progress.phase === 'error') {
            off()
          } else if (progress.phase === 'done') {
            off()
            applyUpdate(latest)
          }
        })
      })
    }
    scheduleUpdateCheck()
  })
}

bootstrap()
