/**
 * DSH 新版本检测:纯判定 + npm dist-tags 探测。
 * 不做任何安装动作;安装/切换仍走 VersionInstaller 与 versions:select 通道。
 */

import { compareVersions, type NpmRunner } from './contracts'
import type { Result } from '../../shared/contracts'
import type { UpdateChannel } from '../../shared/settings'
import { errFromUnknown, ok } from '../util/result'

export interface UpdateCheckResult {
  readonly latest: string
  readonly current: string | null
  readonly updateAvailable: boolean
}

/**
 * 纯判定:active 是否落后于 latest。
 * active 为 null(未装)不算「有更新」——那是首装,不是升级。
 */
export function isUpdateAvailable(activeVersion: string | null, latest: string): boolean {
  if (activeVersion === null || latest.length === 0) {
    return false
  }
  return compareVersions(latest, activeVersion) > 0
}

/**
 * 探测 npm registry 的 dist-tag(按设置选通道,默认 latest;fail-soft:失败时返回 err,不打断启动)。
 * 选定通道缺 tag 时回退 latest。
 */
export async function checkForUpdate(deps: {
  readonly npm: Pick<NpmRunner, 'listDistTags'>
  readonly activeVersion: string | null
  readonly channel?: UpdateChannel
}): Promise<Result<UpdateCheckResult>> {
  try {
    const tags = await deps.npm.listDistTags()
    if (!tags.ok) {
      return tags
    }
    const latest = (deps.channel !== undefined ? tags.value[deps.channel] : undefined) ?? tags.value.latest ?? ''
    return ok({
      latest,
      current: deps.activeVersion,
      updateAvailable: isUpdateAvailable(deps.activeVersion, latest)
    })
  } catch (error) {
    return errFromUnknown('update-check-failed', error)
  }
}
