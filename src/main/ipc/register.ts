/**
 * IPC 注册:invoke 表(channel + zod schema + handler),统一校验、
 * 统一异常转 Result、统一日志。push 通道走 broadcast(全部窗口)。
 */

import { BrowserWindow, ipcMain } from 'electron'
import type { DshRuntimeSnapshot, Result } from '../../shared/contracts'
import type {
  DshRegistryInfo,
  DshVersionInfo,
  EnvHint,
  InstallProgress
} from '../../shared/ipc-types'
import { IpcChannel } from '../../shared/ipc-types'
import {
  installProgressSchema,
  logTailReqSchema,
  registryInfoSchema,
  runtimeSnapshotSchema,
  shellSettingsPatchSchema,
  versionReqSchema,
  voidSchema
} from '../../shared/ipc-schemas'
import type { ShellSettings, ShellSettingsPatch } from '../../shared/settings'
import { getLogger, getLogTail } from '../logger'
import { compareVersions, type NpmRunner } from '../dsh-versions/contracts'
import { scanBuiltinVersions, scanInstalledVersions, unionVersions } from '../dsh-versions/registry'
import { hasDeepseekApiKey, hasDeepseekBaseUrl } from '../deepseek/api-key'
import type { VersionInstaller } from '../dsh-versions/installer'
import type { DshRuntimeSupervisor } from '../dsh-runtime/supervisor'
import type { SettingsStore } from '../settings/store'
import { err, errFromUnknown, ok } from '../util/result'
import type { ZodType } from 'zod'

const log = getLogger('ipc')

export interface IpcActions {
  readonly quit: () => void
  readonly openManage: () => void
  readonly openLogsFolder: () => void
  readonly getActiveVersion: () => string | null
  readonly selectVersion: (version: string) => Result<null>
}

export interface IpcDeps {
  readonly supervisor: DshRuntimeSupervisor
  readonly installer: VersionInstaller
  readonly settingsStore: SettingsStore
  readonly npmRunner: NpmRunner
  readonly versionsRoot: string
  readonly builtinRuntimeRoot: string
  readonly actions: IpcActions
}

interface InvokeEntry {
  readonly channel: string
  readonly schema: ZodType
  readonly handler: (payload: unknown) => unknown
}

export function registerIpc(deps: IpcDeps): void {
  const entries: readonly InvokeEntry[] = [
    {
      channel: IpcChannel.StateGet,
      schema: voidSchema,
      handler: () => deps.supervisor.snapshot()
    },
    {
      channel: IpcChannel.RuntimeRestart,
      schema: voidSchema,
      handler: () => withResult(() => {
        void deps.supervisor.restartNow()
      })
    },
    {
      channel: IpcChannel.RuntimeStop,
      schema: voidSchema,
      handler: () => withResult(() => {
        void deps.supervisor.stop()
      })
    },
    {
      channel: IpcChannel.AppQuit,
      schema: voidSchema,
      handler: () => withResult(() => deps.actions.quit())
    },
    {
      channel: IpcChannel.ManageOpen,
      schema: voidSchema,
      handler: () => withResult(() => deps.actions.openManage())
    },
    {
      channel: IpcChannel.LogsOpenFolder,
      schema: voidSchema,
      handler: () => withResult(() => deps.actions.openLogsFolder())
    },
    {
      channel: IpcChannel.LogsGetTail,
      schema: logTailReqSchema,
      handler: (payload) => getLogTail((payload as { maxLines: number }).maxLines)
    },
    {
      channel: IpcChannel.VersionsList,
      schema: voidSchema,
      handler: () => listVersions(deps)
    },
    {
      channel: IpcChannel.RegistryList,
      schema: voidSchema,
      handler: () => listRegistry(deps)
    },
    {
      channel: IpcChannel.VersionsInstall,
      schema: versionReqSchema,
      handler: (payload) => {
        const { version } = payload as { version: string }
        const result = deps.installer.start(version)
        return result
      }
    },
    {
      channel: IpcChannel.VersionsRemove,
      schema: versionReqSchema,
      handler: (payload) => deps.installer.remove((payload as { version: string }).version)
    },
    {
      channel: IpcChannel.VersionsSelect,
      schema: versionReqSchema,
      handler: (payload) => deps.actions.selectVersion((payload as { version: string }).version)
    },
    {
      channel: IpcChannel.SettingsGet,
      schema: voidSchema,
      handler: () => deps.settingsStore.get()
    },
    {
      channel: IpcChannel.SettingsSet,
      schema: shellSettingsPatchSchema,
      handler: (payload) => deps.settingsStore.update(payload as ShellSettingsPatch)
    },
    {
      channel: IpcChannel.EnvHint,
      schema: voidSchema,
      handler: (): EnvHint => {
        const extraEnv = deps.settingsStore.get().runtime.extraEnv
        return {
          hasDeepseekApiKey: hasDeepseekApiKey(process.env, extraEnv),
          hasDeepseekBaseUrl: hasDeepseekBaseUrl(process.env, extraEnv)
        }
      }
    }
  ]

  for (const entry of entries) {
    ipcMain.handle(entry.channel, (_event, rawPayload: unknown) => {
      const parsed = entry.schema.safeParse(rawPayload)
      if (!parsed.success) {
        log.warn('ipc payload rejected', { channel: entry.channel })
        return err('bad-payload', `参数校验失败:${entry.channel}`)
      }
      try {
        return entry.handler(parsed.data)
      } catch (error) {
        log.error('ipc handler threw', { channel: entry.channel, error: error instanceof Error ? error.message : String(error) })
        return errFromUnknown('handler-error', error)
      }
    })
  }
  log.info('ipc registered', { channels: entries.length })
}

function withResult(action: () => void): Result<null> {
  action()
  return ok(null)
}

function listVersions(deps: IpcDeps): readonly DshVersionInfo[] {
  const all = unionVersions(
    scanInstalledVersions(deps.versionsRoot),
    scanBuiltinVersions(deps.builtinRuntimeRoot)
  )
  const active = deps.actions.getActiveVersion()
  return all.map((v) => ({
    version: v.version,
    installed: true,
    active: v.version === active,
    installedAt: v.installedAt,
    builtin: v.builtin
  }))
}

async function listRegistry(deps: IpcDeps): Promise<Result<DshRegistryInfo>> {
  const [versionsResult, tagsResult] = await Promise.all([
    deps.npmRunner.listRegistryVersions(),
    deps.npmRunner.listDistTags()
  ])
  if (!versionsResult.ok) {
    return versionsResult
  }
  if (!tagsResult.ok) {
    return tagsResult
  }
  const sorted = [...versionsResult.value].sort(compareVersions)
  const info: DshRegistryInfo = {
    latest: tagsResult.value.latest ?? sorted[sorted.length - 1] ?? '',
    distTags: { ...tagsResult.value },
    versions: sorted
  }
  if (!registryInfoSchema.safeParse(info).success) {
    return err('registry-parse', 'registry 信息拼装异常')
  }
  return ok(info)
}

// ---- push 通道广播 ----

export function broadcastSnapshot(snapshot: DshRuntimeSnapshot): void {
  if (!runtimeSnapshotSchema.safeParse(snapshot).success) {
    log.warn('refusing to broadcast invalid snapshot')
    return
  }
  broadcast(IpcChannel.StateChanged, snapshot)
}

export function broadcastInstallProgress(progress: InstallProgress): void {
  if (!installProgressSchema.safeParse(progress).success) {
    log.warn('refusing to broadcast invalid install progress')
    return
  }
  broadcast(IpcChannel.InstallProgress, progress)
}

export function broadcastSettings(settings: ShellSettings): void {
  broadcast(IpcChannel.SettingsChanged, settings)
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send(channel, payload)
    }
  }
}
