import { describe, expect, it } from 'vitest'
import { hasDeepseekApiKey, hasDeepseekBaseUrl, shouldPromptApiKey } from '../../src/main/deepseek/api-key'
import { DEEPSEEK_ENV_KEYS, defaultShellFlags } from '../../src/shared/settings'

const EMPTY_ENV: Readonly<Record<string, string | undefined>> = {}

describe('DeepSeek API Key 判定矩阵', () => {
  it('仅环境变量有 → 已配置', () => {
    expect(hasDeepseekApiKey({ DEEPSEEK_API_KEY: 'sk-1' }, {})).toBe(true)
  })

  it('仅 extraEnv 有 → 已配置', () => {
    expect(hasDeepseekApiKey(EMPTY_ENV, { DEEPSEEK_API_KEY: 'sk-2' })).toBe(true)
  })

  it('空字符串 / 空白视为无', () => {
    expect(hasDeepseekApiKey({ DEEPSEEK_API_KEY: '' }, {})).toBe(false)
    expect(hasDeepseekApiKey({ DEEPSEEK_API_KEY: '   ' }, {})).toBe(false)
    expect(hasDeepseekApiKey(EMPTY_ENV, {})).toBe(false)
  })

  it('Base URL 同口径', () => {
    expect(hasDeepseekBaseUrl({ DEEPSEEK_BASE_URL: 'https://x' }, {})).toBe(true)
    expect(hasDeepseekBaseUrl(EMPTY_ENV, { DEEPSEEK_BASE_URL: 'https://y' })).toBe(true)
    expect(hasDeepseekBaseUrl(EMPTY_ENV, {})).toBe(false)
  })

  it('shouldPromptApiKey:无 key 且未提示过才弹', () => {
    expect(shouldPromptApiKey(EMPTY_ENV, {}, defaultShellFlags)).toBe(true)
    expect(shouldPromptApiKey({ DEEPSEEK_API_KEY: 'sk' }, {}, defaultShellFlags)).toBe(false)
    expect(shouldPromptApiKey(EMPTY_ENV, { DEEPSEEK_API_KEY: 'sk' }, defaultShellFlags)).toBe(false)
    expect(shouldPromptApiKey(EMPTY_ENV, {}, { apiKeyPromptSeen: true })).toBe(false)
  })

  it('键名唯一出处断言(防拼写漂移)', () => {
    expect(DEEPSEEK_ENV_KEYS.apiKey).toBe('DEEPSEEK_API_KEY')
    expect(DEEPSEEK_ENV_KEYS.baseUrl).toBe('DEEPSEEK_BASE_URL')
  })
})
