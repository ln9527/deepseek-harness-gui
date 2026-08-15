/**
 * 跨方(main / preload / renderer)共享的运行时契约 —— 纯类型,零依赖。
 * 全部字段 readonly 到叶子(不可变原则)。
 */

export type DshProcessState =
  | 'idle'
  | 'starting'
  | 'ready'
  | 'restarting'
  | 'stopping'
  | 'stopped'

export interface DshRuntimeError {
  readonly exitCode: number | null
  readonly message: string
  readonly stdioTail: readonly string[]
}

/** supervisor 对外的完整状态快照(每次迁移后推送 renderer)。 */
export interface DshRuntimeSnapshot {
  readonly state: DshProcessState
  readonly port: number | null
  readonly version: string | null
  readonly pid: number | null
  readonly startedAt: number | null
  readonly restartAttempt: number
  readonly nextRestartAtMs: number | null
  readonly lastError: DshRuntimeError | null
  readonly bridgeConnected: boolean
}

/** 唯一的 spawn 契约:壳与 DSH 的命令行级耦合集中在此。 */
export interface DshSpawnContract {
  readonly nodeExec: string
  readonly entryPath: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
}

/** 统一错误载荷:IPC / 内部边界通用。 */
export interface DshShellError {
  readonly code: string
  readonly message: string
}

export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DshShellError }
