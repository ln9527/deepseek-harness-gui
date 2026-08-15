/**
 * 进程状态机:纯 reducer(状态 × 事件 → 次态 + 副作用指令)。
 * 副作用由 supervisor 执行;本模块零 IO、零计时器,表驱动可全量单测。
 */

import type { DshProcessState, DshRuntimeError } from '../../shared/contracts'

export const START_WATCHDOG_MS = 20_000
export const MAX_RESTART_ATTEMPTS = 5
export const BACKOFF_BASE_MS = 1_000
export const BACKOFF_CAP_MS = 60_000
export const READY_STABILIZE_MS = 5 * 60_000
export const GRACEFUL_KILL_ESCALATE_MS = 5_000

export type RuntimeEvent =
  | { readonly type: 'START' }
  | { readonly type: 'BANNER_PARSED'; readonly port: number }
  | { readonly type: 'EXIT'; readonly code: number | null; readonly stdioTail: readonly string[] }
  | { readonly type: 'START_TIMEOUT' }
  | { readonly type: 'BACKOFF_EXPIRED' }
  | { readonly type: 'STOP_REQUEST' }
  | { readonly type: 'RESTART_NOW' }
  | { readonly type: 'READY_STABILIZED' }

export type RuntimeEffect =
  | { readonly type: 'SPAWN' }
  | { readonly type: 'KILL'; readonly signal: 'SIGTERM' }
  | { readonly type: 'SCHEDULE_BACKOFF'; readonly delayMs: number }
  | { readonly type: 'START_WATCHDOG' }
  | { readonly type: 'CANCEL_WATCHDOG' }
  | { readonly type: 'SCHEDULE_STABILIZE' }
  | { readonly type: 'CANCEL_STABILIZE' }
  | { readonly type: 'NOTIFY_CRASHED' }
  | { readonly type: 'EMIT_READY'; readonly port: number }

export interface RuntimeInternalState {
  readonly state: DshProcessState
  readonly port: number | null
  readonly startedAt: number | null
  readonly restartAttempt: number
  readonly nextRestartAtMs: number | null
  readonly lastError: DshRuntimeError | null
  readonly stoppingRequested: boolean
  readonly readySince: number | null
}

export interface RuntimeTransition {
  readonly next: RuntimeInternalState
  readonly effects: readonly RuntimeEffect[]
}

export const initialRuntimeState: RuntimeInternalState = Object.freeze({
  state: 'idle',
  port: null,
  startedAt: null,
  restartAttempt: 0,
  nextRestartAtMs: null,
  lastError: null,
  stoppingRequested: false,
  readySince: null
})

/** 指数退避:base * 2^(attempt-1),封顶 cap。attempt 从 1 起。 */
export function computeBackoffDelay(attempt: number, baseMs = BACKOFF_BASE_MS, capMs = BACKOFF_CAP_MS): number {
  const raw = baseMs * 2 ** Math.max(0, attempt - 1)
  return Math.min(raw, capMs)
}

function unexpectedExitError(code: number | null, stdioTail: readonly string[], context: string): DshRuntimeError {
  return {
    exitCode: code,
    message:
      code === null
        ? `DSH 进程异常终止(${context})`
        : `DSH 进程意外退出,退出码 ${code}(${context})`,
    stdioTail
  }
}

function crashOutcome(
  prev: RuntimeInternalState,
  error: DshRuntimeError,
  nowMs: number
): RuntimeTransition {
  const attempt = prev.restartAttempt + 1
  if (attempt >= MAX_RESTART_ATTEMPTS) {
    return {
      next: { ...prev, state: 'stopped', port: null, restartAttempt: attempt, lastError: error, nextRestartAtMs: null, readySince: null },
      effects: [{ type: 'NOTIFY_CRASHED' }]
    }
  }
  const delayMs = computeBackoffDelay(attempt)
  return {
    next: {
      ...prev,
      state: 'restarting',
      port: null,
      restartAttempt: attempt,
      lastError: error,
      nextRestartAtMs: nowMs + delayMs,
      readySince: null
    },
    effects: [{ type: 'SCHEDULE_BACKOFF', delayMs }]
  }
}


/** 核心 reducer。nowMs 由调用方注入(可测性)。 */
export function transition(prev: RuntimeInternalState, event: RuntimeEvent, nowMs: number): RuntimeTransition {
  switch (event.type) {
    case 'START': {
      if (prev.state !== 'idle' && prev.state !== 'stopped') {
        return { next: prev, effects: [] }
      }
      return {
        next: {
          ...initialRuntimeState,
          state: 'starting',
          stoppingRequested: false
        },
        effects: [{ type: 'SPAWN' }, { type: 'START_WATCHDOG' }]
      }
    }
    case 'BANNER_PARSED': {
      if (prev.state !== 'starting') {
        return { next: prev, effects: [] }
      }
      return {
        next: {
          ...prev,
          state: 'ready',
          port: event.port,
          startedAt: nowMs,
          readySince: nowMs
        },
        effects: [
          { type: 'CANCEL_WATCHDOG' },
          { type: 'EMIT_READY', port: event.port },
          { type: 'SCHEDULE_STABILIZE' }
        ]
      }
    }
    case 'EXIT': {
      if (prev.state === 'stopping' || prev.stoppingRequested) {
        return {
          next: { ...prev, state: 'stopped', port: null, stoppingRequested: false, readySince: null },
          effects: []
        }
      }
      if (prev.state === 'starting' || prev.state === 'ready') {
        const context = prev.state === 'ready' ? '运行中' : '启动中'
        return crashOutcome(prev, unexpectedExitError(event.code, event.stdioTail, context), nowMs)
      }
      return { next: prev, effects: [] }
    }
    case 'START_TIMEOUT': {
      if (prev.state !== 'starting') {
        return { next: prev, effects: [] }
      }
      // 不改态:发 SIGTERM,真正的迁移由随后的 EXIT 事件驱动
      return {
        next: prev,
        effects: [{ type: 'KILL', signal: 'SIGTERM' }]
      }
    }
    case 'BACKOFF_EXPIRED': {
      if (prev.state !== 'restarting') {
        return { next: prev, effects: [] }
      }
      return {
        next: { ...prev, state: 'starting', nextRestartAtMs: null },
        effects: [{ type: 'SPAWN' }, { type: 'START_WATCHDOG' }]
      }
    }
    case 'STOP_REQUEST': {
      if (prev.state === 'idle' || prev.state === 'stopped') {
        return { next: prev, effects: [] }
      }
      if (prev.state === 'restarting') {
        // 退避中无子进程,直接落 stopped
        return {
          next: { ...prev, state: 'stopped', stoppingRequested: false, nextRestartAtMs: null },
          effects: []
        }
      }
      return {
        next: { ...prev, state: 'stopping', stoppingRequested: true, nextRestartAtMs: null },
        effects: [{ type: 'KILL', signal: 'SIGTERM' }]
      }
    }
    case 'RESTART_NOW': {
      if (prev.state !== 'restarting' && prev.state !== 'stopped') {
        return { next: prev, effects: [] }
      }
      return {
        next: { ...initialRuntimeState, state: 'starting' },
        effects: [{ type: 'SPAWN' }, { type: 'START_WATCHDOG' }]
      }
    }
    case 'READY_STABILIZED': {
      if (prev.state !== 'ready') {
        return { next: prev, effects: [] }
      }
      return { next: { ...prev, restartAttempt: 0 }, effects: [] }
    }
    default: {
      // exhaustiveness guard(编译期兜底,运行时不可达)
      const exhaustive: never = event
      void exhaustive
      return { next: prev, effects: [] }
    }
  }
}
