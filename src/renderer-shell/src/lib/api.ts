/** preload API 的类型化访问 + 全局声明。 */

import type { DshShellApi } from '../../../shared/ipc-types'

declare global {
  interface Window {
    dshShell?: DshShellApi
  }
}

export function getApi(): DshShellApi {
  const api = window.dshShell
  if (!api) {
    throw new Error('preload API 不可用(window.dshShell 缺失)')
  }
  return api
}

/** 便捷:Result 错误转可显示文本。 */
export function resultError(result: { ok: boolean; error?: { message: string } }): string {
  if (result.ok || !result.error) {
    return ''
  }
  return result.error.message
}
