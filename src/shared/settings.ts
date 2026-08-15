/**
 * 壳自身偏好设置:类型 + zod schema + 默认值 + 纯函数合并。
 * 文件 IO 在 main/settings/store.ts;此处保持零 electron 依赖。
 */

import { z } from 'zod'

export interface WindowState {
  readonly width: number
  readonly height: number
  readonly x: number | null
  readonly y: number | null
}

export interface LaunchSettings {
  readonly openAtLogin: boolean
  readonly startHidden: boolean
}

export interface NotificationSettings {
  readonly approvals: boolean
  readonly turnComplete: boolean
  readonly errors: boolean
  readonly onlyWhenHidden: boolean
}

export interface RuntimeSettings {
  readonly dshHomeOverride: string | null
  readonly extraEnv: Readonly<Record<string, string>>
}

export interface ShellFlags {
  readonly apiKeyPromptSeen: boolean
}

export const defaultShellFlags: ShellFlags = { apiKeyPromptSeen: false }

/** DeepSeek 凭据键的唯一出处(main 判定 / EnvHint / renderer 读写都用它)。 */
export const DEEPSEEK_ENV_KEYS = {
  apiKey: 'DEEPSEEK_API_KEY',
  baseUrl: 'DEEPSEEK_BASE_URL'
} as const

export interface ShellSettings {
  readonly pinnedVersion: string | null
  readonly window: WindowState
  readonly launch: LaunchSettings
  readonly notifications: NotificationSettings
  readonly runtime: RuntimeSettings
  readonly autoRestart: boolean
  readonly flags: ShellFlags
}

export const shellFlagsSchema = z.object({
  apiKeyPromptSeen: z.boolean()
})

const envKeySchema = /^[A-Za-z_][A-Za-z0-9_]*$/

export const windowStateSchema = z.object({
  width: z.number().int().min(400).max(4000),
  height: z.number().int().min(300).max(4000),
  x: z.number().int().nullable(),
  y: z.number().int().nullable()
})

export const launchSettingsSchema = z.object({
  openAtLogin: z.boolean(),
  startHidden: z.boolean()
})

export const notificationSettingsSchema = z.object({
  approvals: z.boolean(),
  turnComplete: z.boolean(),
  errors: z.boolean(),
  onlyWhenHidden: z.boolean()
})

export const runtimeSettingsSchema = z.object({
  dshHomeOverride: z.string().min(1).nullable(),
  extraEnv: z.record(z.string().regex(envKeySchema), z.string())
})

export const shellSettingsSchema = z.object({
  pinnedVersion: z.string().min(1).nullable(),
  window: windowStateSchema,
  launch: launchSettingsSchema,
  notifications: notificationSettingsSchema,
  runtime: runtimeSettingsSchema,
  autoRestart: z.boolean(),
  // .default():旧 settings.json 无 flags 段时原样通过并补默认值(不触发隔离回退)
  flags: shellFlagsSchema.default(defaultShellFlags)
})

export type ShellSettingsPatch = {
  readonly pinnedVersion?: string | null
  readonly window?: Partial<WindowState>
  readonly launch?: Partial<LaunchSettings>
  readonly notifications?: Partial<NotificationSettings>
  readonly runtime?: Partial<{ dshHomeOverride: string | null; extraEnv: Readonly<Record<string, string>> }>
  readonly autoRestart?: boolean
  readonly flags?: Partial<ShellFlags>
}

export const defaultShellSettings: ShellSettings = deepFreeze({
  pinnedVersion: null,
  window: { width: 1440, height: 900, x: null, y: null },
  launch: { openAtLogin: false, startHidden: false },
  notifications: { approvals: true, turnComplete: true, errors: true, onlyWhenHidden: true },
  runtime: { dshHomeOverride: null, extraEnv: {} },
  autoRestart: true,
  flags: { apiKeyPromptSeen: false }
})

/** 纯函数:显式逐段合并,返回新的冻结对象,绝不修改入参。 */
export function mergeSettings(current: ShellSettings, patch: ShellSettingsPatch): ShellSettings {
  const runtimePatch = patch.runtime
  return deepFreeze({
    pinnedVersion: patch.pinnedVersion !== undefined ? patch.pinnedVersion : current.pinnedVersion,
    window: { ...current.window, ...(patch.window ?? {}) },
    launch: { ...current.launch, ...(patch.launch ?? {}) },
    notifications: { ...current.notifications, ...(patch.notifications ?? {}) },
    runtime: {
      dshHomeOverride:
        runtimePatch?.dshHomeOverride !== undefined ? runtimePatch.dshHomeOverride : current.runtime.dshHomeOverride,
      extraEnv:
        runtimePatch?.extraEnv !== undefined ? { ...runtimePatch.extraEnv } : { ...current.runtime.extraEnv }
    },
    autoRestart: patch.autoRestart !== undefined ? patch.autoRestart : current.autoRestart,
    flags: { ...current.flags, ...(patch.flags ?? {}) }
  })
}

/** 深冻结(两层结构足够;数组/嵌套 record 一并处理)。 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value)
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key])
    }
  }
  return value
}
