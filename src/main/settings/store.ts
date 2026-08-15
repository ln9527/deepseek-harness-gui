/**
 * 设置存储:原子写(tmp + rename)、损坏自愈(备份后回落默认)、订阅广播。
 * 读取返回冻结对象;更新走 mergeSettings 纯函数。
 */

import { readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { getLogger } from '../logger'
import {
  deepFreeze,
  defaultShellSettings,
  mergeSettings,
  shellSettingsSchema,
  type ShellSettings,
  type ShellSettingsPatch
} from '../../shared/settings'

const log = getLogger('settings')

export type SettingsListener = (settings: ShellSettings) => void

export class SettingsStore {
  private current: ShellSettings
  private readonly listeners = new Set<SettingsListener>()

  constructor(private readonly filePath: string) {
    this.current = this.load()
  }

  get(): ShellSettings {
    return this.current
  }

  update(patch: ShellSettingsPatch): ShellSettings {
    const next = mergeSettings(this.current, patch)
    this.persist(next)
    this.current = next
    this.broadcast()
    return next
  }

  subscribe(listener: SettingsListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private load(): ShellSettings {
    try {
      if (!existsSync(this.filePath)) {
        return defaultShellSettings
      }
      const raw = readFileSync(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      const validated = shellSettingsSchema.safeParse(parsed)
      if (!validated.success) {
        this.quarantine(`schema mismatch: ${validated.error.issues[0]?.path.join('.') ?? 'root'}`)
        return defaultShellSettings
      }
      return deepFreeze(validated.data)
    } catch (error) {
      this.quarantine(error instanceof Error ? error.message : String(error))
      return defaultShellSettings
    }
  }

  /** 坏文件改名为 .bak-<ts>,永不因配置损坏而崩壳。 */
  private quarantine(reason: string): void {
    log.warn('settings file unusable, falling back to defaults', { reason })
    try {
      if (existsSync(this.filePath)) {
        renameSync(this.filePath, `${this.filePath}.bak-${Date.now()}`)
      }
    } catch (renameError) {
      log.error('failed to quarantine settings file', {
        error: renameError instanceof Error ? renameError.message : String(renameError)
      })
    }
  }

  private persist(settings: ShellSettings): void {
    const tmpPath = `${this.filePath}.tmp-${Date.now()}`
    try {
      writeFileSync(tmpPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
      renameSync(tmpPath, this.filePath)
    } catch (error) {
      log.error('failed to persist settings', {
        error: error instanceof Error ? error.message : String(error),
        dir: dirname(this.filePath)
      })
      throw new Error(`无法写入设置文件:${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private broadcast(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.current)
      } catch (error) {
        log.error('settings listener threw', {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }
}
