/**
 * runtime supervisor:组装状态机 + 子进程封装 + 计时器,对外只暴露
 * start/stop/restartNow/snapshot 与事件回调。所有上游知识经
 * spawnContractProvider 注入(由 owner 用 dsh-versions 的解析结果构造)。
 */

import type { DshRuntimeError, DshRuntimeSnapshot, DshSpawnContract, Result } from '../../shared/contracts'
import { getLogger } from '../logger'
import { createRingBuffer } from '../util/ring-buffer'
import { err, ok } from '../util/result'
import type { SpawnedChild, ChildProcessFactory } from './child-process'
import { parseBannerPort } from './banner-parser'
import { probeHostDescribe } from './describe-probe'
import {
  computeBackoffDelay,
  initialRuntimeState,
  READY_STABILIZE_MS,
  START_WATCHDOG_MS,
  transition,
  type RuntimeEvent,
  type RuntimeInternalState,
  type RuntimeEffect
} from './state-machine'

const STDIO_TAIL = 50
const STOP_TIMEOUT_MS = 6_500

export interface SupervisorDeps {
  readonly childFactory: ChildProcessFactory
  readonly spawnContractProvider: () => DshSpawnContract | null
  readonly getAutoRestart: () => boolean
  readonly backoffBaseMs?: number
  readonly watchdogMs?: number
  readonly stabilizeMs?: number
  readonly now?: () => number
  readonly probe?: (port: number) => Promise<Result<{ version: string }>>
}

export interface SupervisorCallbacks {
  onSnapshot?(snapshot: DshRuntimeSnapshot): void
  onReady?(port: number): void
  onCrashed?(error: DshRuntimeError): void
}

export class DshRuntimeSupervisor {
  private internal: RuntimeInternalState = initialRuntimeState
  private child: SpawnedChild | null = null
  private currentPid: number | null = null
  private watchdogTimer: NodeJS.Timeout | null = null
  private backoffTimer: NodeJS.Timeout | null = null
  private stabilizeTimer: NodeJS.Timeout | null = null
  private readonly stdoutTail = createRingBuffer<string>(STDIO_TAIL)
  private readonly stderrTail = createRingBuffer<string>(STDIO_TAIL)
  private activeVersion: string | null = null
  private bridgeConnected = false
  private disposed = false

  constructor(
    private readonly deps: SupervisorDeps,
    private readonly callbacks: SupervisorCallbacks = {}
  ) {}

  snapshot(): DshRuntimeSnapshot {
    return {
      state: this.internal.state,
      port: this.internal.port,
      version: this.activeVersion,
      pid: this.currentPid,
      startedAt: this.internal.startedAt,
      restartAttempt: this.internal.restartAttempt,
      nextRestartAtMs: this.internal.nextRestartAtMs,
      lastError: this.internal.lastError,
      bridgeConnected: this.bridgeConnected
    }
  }

  setVersion(version: string | null): void {
    this.activeVersion = version
    this.publish()
  }

  setBridgeConnected(connected: boolean): void {
    if (this.bridgeConnected !== connected) {
      this.bridgeConnected = connected
      this.publish()
    }
  }

  start(): Result<null> {
    if (this.deps.spawnContractProvider() === null) {
      return err('no-version', '尚未安装任何 DSH 版本,请先在管理页安装')
    }
    this.dispatch({ type: 'START' })
    return ok(null)
  }

  /** 优雅停止:STOP_REQUEST → 等子进程退出(超时强杀)。 */
  async stop(): Promise<void> {
    if (this.internal.state === 'idle' || this.internal.state === 'stopped') {
      return
    }
    if (this.internal.state === 'restarting') {
      this.dispatch({ type: 'STOP_REQUEST' })
      return
    }
    const exited = new Promise<void>((resolve) => {
      const unsubscribe = this.onInternalState(() => {
        if (this.internal.state === 'stopped') {
          unsubscribe()
          resolve()
        }
      })
    })
    this.dispatch({ type: 'STOP_REQUEST' })
    const forceTimer = setTimeout(() => {
      this.child?.killNow()
    }, STOP_TIMEOUT_MS - 500)
    await Promise.race([exited, sleep(STOP_TIMEOUT_MS)])
    clearTimeout(forceTimer)
  }

  /** 用户手动重启:任何状态都收敛到 重新 starting。 */
  async restartNow(): Promise<void> {
    if (this.internal.state === 'starting' || this.internal.state === 'ready' || this.internal.state === 'stopping') {
      await this.stop()
    }
    if (this.disposed) {
      return
    }
    this.dispatch({ type: 'RESTART_NOW' })
  }

  dispose(): void {
    this.disposed = true
    this.clearTimers()
    this.child?.killGracefully()
  }

  // ---- 内部 ----

  private readonly listeners = new Set<() => void>()

  private onInternalState(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => {
      this.listeners.delete(cb)
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  private dispatch(event: RuntimeEvent): void {
    const result = transition(this.internal, event, this.now())
    if (result.next === this.internal) {
      return
    }
    this.internal = result.next
    for (const effect of result.effects) {
      this.applyEffect(effect)
    }
    this.publish()
    for (const listener of [...this.listeners]) {
      listener()
    }
  }

  private applyEffect(effect: RuntimeEffect): void {
    const log = getLogger('supervisor')
    switch (effect.type) {
      case 'SPAWN':
        this.spawnChild()
        break
      case 'KILL':
        log.info('sending SIGTERM to DSH child')
        this.child?.killGracefully()
        break
      case 'SCHEDULE_BACKOFF': {
        this.clearBackoff()
        // deps.backoffBaseMs 仅供测试加速;生产走 reducer 默认值
        const delay = this.deps.backoffBaseMs
          ? computeBackoffDelay(this.internal.restartAttempt, this.deps.backoffBaseMs)
          : effect.delayMs
        this.backoffTimer = setTimeout(() => {
          this.backoffTimer = null
          this.dispatch({ type: 'BACKOFF_EXPIRED' })
        }, delay)
        break
      }
      case 'START_WATCHDOG':
        this.clearWatchdog()
        this.watchdogTimer = setTimeout(() => {
          this.watchdogTimer = null
          log.warn('startup watchdog fired: no banner within timeout')
          this.dispatch({ type: 'START_TIMEOUT' })
        }, this.deps.watchdogMs ?? START_WATCHDOG_MS)
        break
      case 'CANCEL_WATCHDOG':
        this.clearWatchdog()
        break
      case 'SCHEDULE_STABILIZE':
        this.clearStabilize()
        this.stabilizeTimer = setTimeout(() => {
          this.stabilizeTimer = null
          this.dispatch({ type: 'READY_STABILIZED' })
        }, this.deps.stabilizeMs ?? READY_STABILIZE_MS)
        break
      case 'CANCEL_STABILIZE':
        this.clearStabilize()
        break
      case 'NOTIFY_CRASHED':
        if (this.internal.lastError) {
          this.callbacks.onCrashed?.(this.internal.lastError)
        }
        break
      case 'EMIT_READY': {
        this.callbacks.onReady?.(effect.port)
        const probeFn = this.deps.probe ?? probeHostDescribe
        void probeFn(effect.port).then((result) => {
          if (result.ok) {
            getLogger('supervisor').info('host.describe ok', { version: result.value.version, expected: this.activeVersion })
          } else {
            getLogger('supervisor').warn('host.describe probe failed (non-fatal)', { code: result.error.code })
          }
        })
        break
      }
      default: {
        const exhaustive: never = effect
        void exhaustive
      }
    }
  }

  private spawnChild(): void {
    const log = getLogger('supervisor')
    const contract = this.deps.spawnContractProvider()
    if (contract === null) {
      log.error('spawn requested but no contract available')
      this.dispatch({ type: 'EXIT', code: null, stdioTail: ['[dsh-gui] no spawn contract'] })
      return
    }
    this.stdoutTail.clear()
    this.stderrTail.clear()
    this.child = this.deps.childFactory.spawn(contract)
    this.currentPid = this.child.pid
    this.child.onStdoutLine((line) => {
      this.stdoutTail.push(line)
      const port = parseBannerPort(line)
      if (port !== null && this.internal.state === 'starting') {
        log.info('banner parsed', { port })
        this.dispatch({ type: 'BANNER_PARSED', port })
      }
    })
    this.child.onStderrLine((line) => {
      this.stderrTail.push(line)
      log.debug('[dsh-stderr]', line)
    })
    this.child.onExit((code) => {
      this.child = null
      this.currentPid = null
      const tail = [...this.stderrTail.items(), ...this.stdoutTail.items()].slice(-STDIO_TAIL)
      if (!this.internal.stoppingRequested && !this.deps.getAutoRestart()) {
        // 设置关闭了自动重启:收敛到 stopped 而不是退避循环
        this.dispatch({ type: 'STOP_REQUEST' })
      }
      this.dispatch({ type: 'EXIT', code, stdioTail: tail })
    })
  }

  private clearWatchdog(): void {
    if (this.watchdogTimer) {
      clearTimeout(this.watchdogTimer)
      this.watchdogTimer = null
    }
  }

  private clearBackoff(): void {
    if (this.backoffTimer) {
      clearTimeout(this.backoffTimer)
      this.backoffTimer = null
    }
  }

  private clearStabilize(): void {
    if (this.stabilizeTimer) {
      clearTimeout(this.stabilizeTimer)
      this.stabilizeTimer = null
    }
  }

  private clearTimers(): void {
    this.clearWatchdog()
    this.clearBackoff()
    this.clearStabilize()
  }

  private publish(): void {
    this.callbacks.onSnapshot?.(this.snapshot())
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
