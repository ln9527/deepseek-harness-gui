/**
 * 子进程封装:spawn + readline 逐行 + 优雅击杀(SIGTERM → 升级 SIGKILL)。
 * 以接口注入(supervisor 依赖接口,测试注入 fake)。
 * 注意:IO 封装类内部存在私有可变状态(事件注册表/计时器),
 * 对外仅暴露不可变视图与订阅退订函数。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { EventEmitter } from 'node:events'
import type { DshSpawnContract } from '../../shared/contracts'
import { GRACEFUL_KILL_ESCALATE_MS } from './state-machine'

export interface SpawnedChild {
  readonly pid: number | null
  onStdoutLine(listener: (line: string) => void): () => void
  onStderrLine(listener: (line: string) => void): () => void
  onExit(listener: (code: number | null) => void): () => void
  /** SIGTERM → 5s 未退 → SIGKILL;幂等。 */
  killGracefully(): void
  killNow(): void
}

export interface ChildProcessFactory {
  spawn(contract: DshSpawnContract): SpawnedChild
}

class RealSpawnedChild implements SpawnedChild {
  private readonly emitter = new EventEmitter()
  private killTimer: NodeJS.Timeout | null = null
  private exited = false

  constructor(private readonly child: ChildProcess) {
    if (this.child.stdout) {
      createInterface({ input: this.child.stdout }).on('line', (line) => {
        this.emitter.emit('stdout-line', line)
      })
    }
    if (this.child.stderr) {
      createInterface({ input: this.child.stderr }).on('line', (line) => {
        this.emitter.emit('stderr-line', line)
      })
    }
    this.child.on('exit', (code) => {
      this.exited = true
      if (this.killTimer) {
        clearTimeout(this.killTimer)
        this.killTimer = null
      }
      this.emitter.emit('exit', code)
    })
    this.child.on('error', (error) => {
      this.emitter.emit('stderr-line', `[spawn error] ${error.message}`)
      if (!this.exited) {
        this.exited = true
        this.emitter.emit('exit', null)
      }
    })
  }

  get pid(): number | null {
    return this.child.pid ?? null
  }

  onStdoutLine(listener: (line: string) => void): () => void {
    this.emitter.on('stdout-line', listener)
    return () => {
      this.emitter.off('stdout-line', listener)
    }
  }

  onStderrLine(listener: (line: string) => void): () => void {
    this.emitter.on('stderr-line', listener)
    return () => {
      this.emitter.off('stderr-line', listener)
    }
  }

  onExit(listener: (code: number | null) => void): () => void {
    this.emitter.on('exit', listener)
    return () => {
      this.emitter.off('exit', listener)
    }
  }

  killGracefully(): void {
    if (this.exited) {
      return
    }
    try {
      this.child.kill('SIGTERM')
    } catch {
      // 已死则忽略
    }
    if (this.killTimer) {
      clearTimeout(this.killTimer)
    }
    this.killTimer = setTimeout(() => {
      if (!this.exited) {
        try {
          this.child.kill('SIGKILL')
        } catch {
          // 已死则忽略
        }
      }
    }, GRACEFUL_KILL_ESCALATE_MS)
  }

  killNow(): void {
    if (this.exited) {
      return
    }
    try {
      this.child.kill('SIGKILL')
    } catch {
      // 已死则忽略
    }
  }
}

export const realChildProcessFactory: ChildProcessFactory = {
  spawn(contract: DshSpawnContract): SpawnedChild {
    const child = spawn(contract.nodeExec, [...contract.args], {
      env: { ...contract.env },
      cwd: contract.cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return new RealSpawnedChild(child)
  }
}
