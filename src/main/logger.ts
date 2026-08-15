/**
 * 唯一日志通道:electron-log 落盘 + 内存环形缓冲供管理页查看尾部。
 * 项目内禁止直接 console.*(编码规范)。
 */

import electronLog from 'electron-log/main'
import { createRingBuffer, type RingBuffer } from './util/ring-buffer'

export interface LogRecord {
  readonly time: number
  readonly level: string
  readonly scope: string
  readonly message: string
}

const UI_TAIL_CAPACITY = 500

/** 测试/纯 node 环境下不触碰 electron-log 传输层(避免依赖 electron app)。 */
const inElectron = typeof process.versions.electron === 'string'

let tail: RingBuffer<LogRecord> | null = null

export interface AppLogger {
  debug(message: string, ...meta: readonly unknown[]): void
  info(message: string, ...meta: readonly unknown[]): void
  warn(message: string, ...meta: readonly unknown[]): void
  error(message: string, ...meta: readonly unknown[]): void
}

function record(level: string, scope: string, message: string, meta: readonly unknown[]): void {
  const metaText = meta.length > 0 ? ` ${meta.map((m) => JSON.stringify(m)).join(' ')}` : ''
  tail?.push({ time: Date.now(), level, scope, message: `${message}${metaText}` })
}

export function initLogger(logsDir: string): void {
  if (!inElectron) {
    return
  }
  electronLog.transports.file.resolvePathFn = () => `${logsDir}/main.log`
  electronLog.transports.file.maxSize = 5 * 1024 * 1024
  electronLog.transports.console.level = 'debug'
  tail = createRingBuffer<LogRecord>(UI_TAIL_CAPACITY)
  electronLog.initialize()
  electronLog.info('[logger] initialized', { logsDir })
}

/** 按域取名;记录进 UI 环形缓冲并转发 electron-log。 */
export function getLogger(scope: string): AppLogger {
  const scoped = inElectron ? electronLog.scope(scope) : null
  return {
    debug(message: string, ...meta: readonly unknown[]): void {
      scoped?.debug(message, ...meta)
      record('debug', scope, message, meta)
    },
    info(message: string, ...meta: readonly unknown[]): void {
      scoped?.info(message, ...meta)
      record('info', scope, message, meta)
    },
    warn(message: string, ...meta: readonly unknown[]): void {
      scoped?.warn(message, ...meta)
      record('warn', scope, message, meta)
    },
    error(message: string, ...meta: readonly unknown[]): void {
      scoped?.error(message, ...meta)
      record('error', scope, message, meta)
    }
  }
}

/** UI 用:最近 maxLines 行(时间倒序正序化)。 */
export function getLogTail(maxLines: number): readonly string[] {
  if (!tail) {
    return []
  }
  const items = tail.items()
  const sliced = items.slice(Math.max(0, items.length - maxLines))
  return sliced.map((r) => `${new Date(r.time).toLocaleTimeString()} [${r.level}] (${r.scope}) ${r.message}`)
}
