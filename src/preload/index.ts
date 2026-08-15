/**
 * preload:contextBridge 暴露 DshShellApi —— 只暴露方法与订阅器,
 * 不暴露 ipcRenderer/Event 对象。订阅器返回退订函数。
 */

import { contextBridge, ipcRenderer } from 'electron'
import type { DshShellApi } from '../shared/ipc-types'
import { IpcChannel } from '../shared/ipc-types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.off(channel, listener)
  }
}

const api: DshShellApi = {
  getState: () => ipcRenderer.invoke(IpcChannel.StateGet),
  onState: (cb) => subscribe(IpcChannel.StateChanged, cb),
  restartRuntime: () => ipcRenderer.invoke(IpcChannel.RuntimeRestart),
  stopRuntime: () => ipcRenderer.invoke(IpcChannel.RuntimeStop),
  quitApp: () => ipcRenderer.invoke(IpcChannel.AppQuit),
  openManageWindow: () => ipcRenderer.invoke(IpcChannel.ManageOpen),
  listVersions: () => ipcRenderer.invoke(IpcChannel.VersionsList),
  listRegistry: () => ipcRenderer.invoke(IpcChannel.RegistryList),
  installVersion: (req) => ipcRenderer.invoke(IpcChannel.VersionsInstall, req),
  removeVersion: (req) => ipcRenderer.invoke(IpcChannel.VersionsRemove, req),
  selectVersion: (req) => ipcRenderer.invoke(IpcChannel.VersionsSelect, req),
  onInstallProgress: (cb) => subscribe(IpcChannel.InstallProgress, cb),
  getSettings: () => ipcRenderer.invoke(IpcChannel.SettingsGet),
  setSettings: (patch) => ipcRenderer.invoke(IpcChannel.SettingsSet, patch),
  onSettingsChanged: (cb) => subscribe(IpcChannel.SettingsChanged, cb),
  openLogsFolder: () => ipcRenderer.invoke(IpcChannel.LogsOpenFolder),
  getLogTail: (req) => ipcRenderer.invoke(IpcChannel.LogsGetTail, req),
  getEnvHint: () => ipcRenderer.invoke(IpcChannel.EnvHint)
}

contextBridge.exposeInMainWorld('dshShell', api)
