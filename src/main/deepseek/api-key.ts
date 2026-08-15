/**
 * DeepSeek API Key 判定(纯函数,零 electron/fs 依赖):
 * 环境变量与壳设置 extraEnv 任一有非空值即视为"已配置";
 * 都没有且未曾提示过 → 应弹一次引导。
 */

import { DEEPSEEK_ENV_KEYS, type ShellFlags } from '../../shared/settings'

function nonEmpty(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

export function hasDeepseekApiKey(
  env: Readonly<Record<string, string | undefined>>,
  extraEnv: Readonly<Record<string, string>>
): boolean {
  return nonEmpty(env[DEEPSEEK_ENV_KEYS.apiKey]) || nonEmpty(extraEnv[DEEPSEEK_ENV_KEYS.apiKey])
}

export function hasDeepseekBaseUrl(
  env: Readonly<Record<string, string | undefined>>,
  extraEnv: Readonly<Record<string, string>>
): boolean {
  return nonEmpty(env[DEEPSEEK_ENV_KEYS.baseUrl]) || nonEmpty(extraEnv[DEEPSEEK_ENV_KEYS.baseUrl])
}

export function shouldPromptApiKey(
  env: Readonly<Record<string, string | undefined>>,
  extraEnv: Readonly<Record<string, string>>,
  flags: ShellFlags
): boolean {
  return !hasDeepseekApiKey(env, extraEnv) && !flags.apiKeyPromptSeen
}
