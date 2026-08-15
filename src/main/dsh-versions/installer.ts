/**
 * 安装 job:单并发、进度推送(phase 粗粒度映射 npm 输出)、完成/失败回调。
 * 只管安装与删除;切换 active 版本由 main.ts 编排(改 settings + 重启 runtime)。
 */

import { randomUUID } from 'node:crypto'
import type { Result } from '../../shared/contracts'
import type { InstallProgress } from '../../shared/ipc-types'
import { getLogger } from '../logger'
import { err, ok } from '../util/result'
import type { InstalledVersion, NpmRunner } from './contracts'
import { installVersion, removeVersion } from './registry'

const log = getLogger('installer')

export interface InstallerDeps {
  readonly npm: NpmRunner
  readonly versionsRoot: string
  readonly nodeMajorMinor: string
  readonly getActiveVersion: () => string | null
  /** 内置版本谓词(Resources 树只读,不可删除)。 */
  readonly isBuiltinVersion: (version: string) => boolean
  readonly onInstalled?: (version: InstalledVersion) => void
  readonly onRemoved?: (version: string) => void
}

type ProgressListener = (progress: InstallProgress) => void

const DOWNLOAD_HINT = /rebuild|extract|fetch|download|http/i

export class VersionInstaller {
  private currentJob: { readonly jobId: string; readonly version: string } | null = null
  private readonly listeners = new Set<ProgressListener>()

  constructor(private readonly deps: InstallerDeps) {}

  onProgress(listener: ProgressListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  isBusy(): boolean {
    return this.currentJob !== null
  }

  start(version: string): Result<{ jobId: string }> {
    if (this.currentJob !== null) {
      return err('install-in-progress', `正在安装 ${this.currentJob.version},请稍候`)
    }
    const jobId = randomUUID()
    this.currentJob = { jobId, version }
    void this.run(jobId, version)
    return ok({ jobId })
  }

  remove(version: string): Result<null> {
    if (this.deps.isBuiltinVersion(version)) {
      return err('version-builtin', '内置版本随应用分发,不可删除;可在版本页安装并切换到其他版本')
    }
    if (version === this.deps.getActiveVersion()) {
      return err('version-active', `${version} 是当前运行版本,先切换到其他版本再删除`)
    }
    if (this.currentJob?.version === version) {
      return err('install-in-progress', `${version} 正在安装中`)
    }
    const result = removeVersion(this.deps.versionsRoot, version)
    if (result.ok) {
      this.deps.onRemoved?.(version)
    }
    return result
  }

  private async run(jobId: string, version: string): Promise<void> {
    let sawDownload = false
    try {
      this.emit({ jobId, version, phase: 'resolving', lastLine: null, error: null })
      const result = await installVersion({
        npm: this.deps.npm,
        versionsRoot: this.deps.versionsRoot,
        version,
        nodeMajorMinor: this.deps.nodeMajorMinor,
        onLine: (line) => {
          if (!sawDownload && DOWNLOAD_HINT.test(line)) {
            sawDownload = true
            this.emit({ jobId, version, phase: 'downloading', lastLine: line, error: null })
          } else {
            this.emit({ jobId, version, phase: 'installing', lastLine: line, error: null })
          }
        }
      })
      if (!result.ok) {
        this.emit({ jobId, version, phase: 'error', lastLine: null, error: result.error.message })
        log.error('install failed', { version, code: result.error.code })
        return
      }
      this.emit({ jobId, version, phase: 'finalizing', lastLine: null, error: null })
      this.emit({ jobId, version, phase: 'done', lastLine: null, error: null })
      this.deps.onInstalled?.(result.value)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.emit({ jobId, version, phase: 'error', lastLine: null, error: message })
      log.error('install threw', { version, error: message })
    } finally {
      this.currentJob = null
    }
  }

  private emit(progress: InstallProgress): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(progress)
      } catch (error) {
        log.error('progress listener threw', {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }
}
