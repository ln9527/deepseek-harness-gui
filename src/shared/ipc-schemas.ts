/**
 * IPC 载荷的 zod schema —— main 侧注册处统一校验,renderer 侧可复用。
 */

import { z } from 'zod'
import type { DshRuntimeSnapshot, Result } from './contracts'
import type {
  DshRegistryInfo,
  DshVersionInfo,
  EnvHint,
  InstallProgress
} from './ipc-types'
import {
  launchSettingsSchema,
  notificationSettingsSchema,
  runtimeSettingsSchema,
  shellFlagsSchema,
  windowStateSchema
} from './settings'

export const voidSchema = z.void().or(z.undefined())

export const versionReqSchema = z.object({ version: z.string().min(1) })

export const logTailReqSchema = z.object({ maxLines: z.number().int().min(1).max(2000) })

const runtimeErrorSchema = z.object({
  exitCode: z.number().int().nullable(),
  message: z.string(),
  stdioTail: z.array(z.string())
})

/** 快照 schema:main 推送前 / renderer 消费前都可校验。 */
export const runtimeSnapshotSchema = z.object({
  state: z.enum(['idle', 'starting', 'ready', 'restarting', 'stopping', 'stopped']),
  port: z.number().int().nullable(),
  version: z.string().nullable(),
  pid: z.number().int().nullable(),
  startedAt: z.number().nullable(),
  restartAttempt: z.number().int(),
  nextRestartAtMs: z.number().nullable(),
  lastError: runtimeErrorSchema.nullable(),
  bridgeConnected: z.boolean()
})

export const versionInfoSchema = z.object({
  version: z.string(),
  installed: z.boolean(),
  active: z.boolean(),
  installedAt: z.number().nullable(),
  builtin: z.boolean()
})

export const registryInfoSchema = z.object({
  latest: z.string(),
  distTags: z.record(z.string(), z.string()),
  versions: z.array(z.string())
})

export const installProgressSchema = z.object({
  jobId: z.string(),
  version: z.string(),
  phase: z.enum(['resolving', 'downloading', 'installing', 'finalizing', 'done', 'error']),
  lastLine: z.string().nullable(),
  error: z.string().nullable()
})

export const envHintSchema = z.object({
  hasDeepseekApiKey: z.boolean(),
  hasDeepseekBaseUrl: z.boolean()
})

export const shellSettingsPatchSchema = z.object({
  pinnedVersion: z.string().min(1).nullable().optional(),
  window: windowStateSchema.partial().optional(),
  launch: launchSettingsSchema.partial().optional(),
  notifications: notificationSettingsSchema.partial().optional(),
  runtime: runtimeSettingsSchema.partial().optional(),
  autoRestart: z.boolean().optional(),
  flags: shellFlagsSchema.partial().optional()
})

// ---- Result 帮助类型(schema 不覆盖泛型 Result,仅用于文档一致性) ----
export type IpcResult<T> = Result<T>
export type { DshRuntimeSnapshot, DshRegistryInfo, DshVersionInfo, EnvHint, InstallProgress }
