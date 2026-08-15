/** Result<T> 构造帮助。 */

import type { Result } from '../../shared/contracts'

export function ok<T>(value: T): Result<T> {
  return { ok: true, value }
}

export function err<T = null>(code: string, message: string): Result<T> {
  return { ok: false, error: { code, message } }
}

/** 把未知异常安全转为 Result(消息不泄露堆栈,但保留 error 文本)。 */
export function errFromUnknown<T = null>(code: string, error: unknown): Result<T> {
  const message = error instanceof Error ? error.message : String(error)
  return err<T>(code, message)
}
