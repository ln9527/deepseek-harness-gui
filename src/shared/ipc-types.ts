/**
 * IPC 面的唯一定义:channel 常量、renderer 可调用 API 形状、载荷视图类型。
 * preload 按此实现,main 按此注册,renderer 按此消费。
 */

import type { DshRuntimeSnapshot, Result } from './contracts'
import type { ShellSettings, ShellSettingsPatch } from './settings'

export const IpcChannel = {
  // renderer → main (invoke)
  StateGet: 'state:get',
  RuntimeRestart: 'runtime:restart',
  RuntimeStop: 'runtime:stop',
  VersionsList: 'versions:list',
  RegistryList: 'registry:list',
  VersionsInstall: 'versions:install',
  VersionsRemove: 'versions:remove',
  VersionsSelect: 'versions:select',
  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',
  LogsOpenFolder: 'logs:openFolder',
  LogsGetTail: 'logs:getTail',
  EnvHint: 'env:hint',
  AppQuit: 'app:quit',
  ManageOpen: 'manage:open',
  // main → renderer (push)
  StateChanged: 'state:changed',
  InstallProgress: 'install:progress',
  SettingsChanged: 'settings:changed'
} as const

export type IpcChannelName = (typeof IpcChannel)[keyof typeof IpcChannel]

export interface DshVersionInfo {
  readonly version: string
  readonly installed: boolean
  readonly active: boolean
  readonly installedAt: number | null
  /** true = 随安装包内置(只读);false = 本机 npm 安装。 */
  readonly builtin: boolean
}

/** npm registry 上可安装的版本信息(setup 向导 / 版本面板用)。 */
export interface DshRegistryInfo {
  readonly latest: string
  readonly distTags: Readonly<Record<string, string>>
  readonly versions: readonly string[]
}

export type InstallPhase = 'resolving' | 'downloading' | 'installing' | 'finalizing' | 'done' | 'error'

export interface InstallProgress {
  readonly jobId: string
  readonly version: string
  readonly phase: InstallPhase
  readonly lastLine: string | null
  readonly error: string | null
}

/** GUI 进程环境提示(Finder 启动不继承 shell env 的提醒)。 */
export interface EnvHint {
  readonly hasDeepseekApiKey: boolean
  readonly hasDeepseekBaseUrl: boolean
}

/** preload 通过 contextBridge 暴露的全部面。只暴露方法与订阅器。 */
export interface DshShellApi {
  getState(): Promise<DshRuntimeSnapshot>
  onState(cb: (snapshot: DshRuntimeSnapshot) => void): () => void
  restartRuntime(): Promise<Result<null>>
  stopRuntime(): Promise<Result<null>>
  quitApp(): Promise<Result<null>>
  openManageWindow(): Promise<Result<null>>
  listVersions(): Promise<readonly DshVersionInfo[]>
  listRegistry(): Promise<Result<DshRegistryInfo>>
  installVersion(req: { version: string }): Promise<Result<{ jobId: string }>>
  removeVersion(req: { version: string }): Promise<Result<null>>
  selectVersion(req: { version: string }): Promise<Result<null>>
  onInstallProgress(cb: (p: InstallProgress) => void): () => void
  getSettings(): Promise<ShellSettings>
  setSettings(patch: ShellSettingsPatch): Promise<ShellSettings>
  onSettingsChanged(cb: (s: ShellSettings) => void): () => void
  openLogsFolder(): Promise<Result<null>>
  getLogTail(req: { maxLines: number }): Promise<readonly string[]>
  getEnvHint(): Promise<EnvHint>
}
