import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyToTree,
  buildGlm53Entry,
  patchCatalog,
  PROVIDER_DATA_RELATIVE,
} from '../../scripts/patch-glm53.mjs'

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** The shipped glm-5.2 entry from pi-ai's zai-coding-cn.json (rc.6), verbatim. */
const GLM_52 = {
  id: 'glm-5.2',
  name: 'GLM-5.2',
  api: 'openai-completions',
  provider: 'zai-coding-cn',
  baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
  reasoning: true,
  thinkingLevelMap: { minimal: null, low: 'high', medium: 'high', high: 'high', max: 'max' },
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: {
    supportsStore: false,
    supportsDeveloperRole: false,
    supportsReasoningEffort: true,
    thinkingFormat: 'zai',
    zaiToolStream: true,
  },
  contextWindow: 1000000,
  maxTokens: 131072,
} as const

function catalogWith(models: Record<string, unknown>): Record<string, unknown> {
  return { 'openai-completions': { ...models } }
}

describe('buildGlm53Entry', () => {
  it('clones glm-5.2 wholesale and only swaps identity plus the level map', () => {
    const entry = buildGlm53Entry(GLM_52)

    expect(entry.id).toBe('glm-5.3')
    expect(entry.name).toBe('GLM-5.3')
    // Everything the status bar and the wire depend on rides along unchanged.
    expect(entry.api).toBe('openai-completions')
    expect(entry.provider).toBe('zai-coding-cn')
    expect(entry.baseUrl).toBe('https://open.bigmodel.cn/api/coding/paas/v4')
    expect(entry.reasoning).toBe(true)
    expect(entry.input).toEqual(['text'])
    expect(entry.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    expect(entry.compat).toEqual(GLM_52.compat)
    expect(entry.contextWindow).toBe(1000000)
    expect(entry.maxTokens).toBe(131072)
  })

  it('exposes the official GLM-5.3 thinking levels: low/high/max, always on', () => {
    const entry = buildGlm53Entry(GLM_52)

    // Official docs: 5.3 supports low/high/max and can no longer disable thinking.
    // 5.2's map clamped low→high; 5.3 passes a real low through. minimal stays
    // unsupported (null) and there is no off/none key, matching 5.2's shape.
    expect(entry.thinkingLevelMap).toEqual({
      minimal: null,
      low: 'low',
      medium: 'high',
      high: 'high',
      max: 'max',
    })
    expect((entry.compat as Record<string, unknown>).supportsReasoningEffort).toBe(true)
  })
})

describe('patchCatalog', () => {
  it('inserts glm-5.3 directly after glm-5.2, preserving every other model', () => {
    const catalog = catalogWith({
      'glm-5.1': { id: 'glm-5.1', name: 'GLM-5.1' },
      'glm-5.2': GLM_52,
      'glm-5v-turbo': { id: 'glm-5v-turbo', name: 'GLM-5V-Turbo' },
    })

    const { catalog: next, changed } = patchCatalog(catalog)

    expect(changed).toBe(true)
    expect(Object.keys(next['openai-completions'])).toEqual([
      'glm-5.1',
      'glm-5.2',
      'glm-5.3',
      'glm-5v-turbo',
    ])
  })

  it('is idempotent: a second pass changes nothing', () => {
    const first = patchCatalog(catalogWith({ 'glm-5.2': GLM_52 }))
    const second = patchCatalog(first.catalog)

    expect(second.changed).toBe(false)
    expect(second.catalog).toEqual(first.catalog)
  })

  it('leaves a foreign glm-5.3 entry alone (upstream may ship its own)', () => {
    const foreign = catalogWith({
      'glm-5.2': GLM_52,
      'glm-5.3': { id: 'glm-5.3', upstream: true },
    })

    const result = patchCatalog(foreign)

    expect(result.changed).toBe(false)
    expect(result.catalog['openai-completions']['glm-5.3']).toEqual({ id: 'glm-5.3', upstream: true })
  })

  it('skips files with no glm-5.2 anchor rather than guessing', () => {
    const catalog = catalogWith({ 'glm-4.7': { id: 'glm-4.7' } })

    const result = patchCatalog(catalog)

    expect(result.changed).toBe(false)
    expect(result.catalog).toEqual(catalog)
  })
})

describe('applyToTree', () => {
  it('patches both zai catalog files on disk and stays idempotent', () => {
    const versionsRoot = mkdtempSync(join(tmpdir(), 'dsh-gui-glm53-'))
    tmpDirs.push(versionsRoot)
    const dataDir = join(versionsRoot, '0.1.0-rc.6', PROVIDER_DATA_RELATIVE)
    mkdirSync(dataDir, { recursive: true })
    for (const file of ['zai-coding-cn.json', 'zai.json']) {
      const glm52 = { ...GLM_52, provider: 'zai', baseUrl: 'https://api.z.ai/api/coding/paas/v4' }
      writeFileSync(
        join(dataDir, file),
        `${JSON.stringify(catalogWith({ 'glm-5.2': glm52 }))}\n`,
        'utf8',
      )
    }

    const first = applyToTree(versionsRoot, '0.1.0-rc.6')
    expect(first).toHaveLength(2)
    expect(first.every((r) => r.changed)).toBe(true)

    for (const file of ['zai-coding-cn.json', 'zai.json']) {
      const patched = JSON.parse(readFileSync(join(dataDir, file), 'utf8'))
      const entry = patched['openai-completions']['glm-5.3']
      expect(entry).toBeDefined()
      expect(entry.thinkingLevelMap.low).toBe('low')
      expect(entry.compat.supportsReasoningEffort).toBe(true)
    }

    const second = applyToTree(versionsRoot, '0.1.0-rc.6')
    expect(second.every((r) => r.changed)).toBe(false)
  })

  it('reports missing files without throwing', () => {
    const versionsRoot = mkdtempSync(join(tmpdir(), 'dsh-gui-glm53-empty-'))
    tmpDirs.push(versionsRoot)

    const results = applyToTree(versionsRoot, '0.1.0-rc.6')

    expect(results.every((r) => !r.changed && r.status === 'missing')).toBe(true)
  })
})
