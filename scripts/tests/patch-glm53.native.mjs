/** Native Node test: importing the plain CLI module through Vitest's Windows
 * module transformer produced a SyntaxError before any assertion could run. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import { applyToTree, buildGlm53Entry, patchCatalog, PROVIDER_DATA_RELATIVE } from '../patch-glm53.mjs'

const tmpDirs = []
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const GLM_52 = {
  id: 'glm-5.2', name: 'GLM-5.2', api: 'openai-completions', provider: 'zai-coding-cn',
  baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', reasoning: true,
  thinkingLevelMap: { minimal: null, low: 'high', medium: 'high', high: 'high', max: 'max' },
  input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: true,
    thinkingFormat: 'zai', zaiToolStream: true },
  contextWindow: 1000000, maxTokens: 131072,
}

const catalogWith = models => ({ 'openai-completions': { ...models } })

describe('buildGlm53Entry', () => {
  it('clones glm-5.2 wholesale and only swaps identity plus the level map', () => {
    const entry = buildGlm53Entry(GLM_52)
    assert.equal(entry.id, 'glm-5.3')
    assert.equal(entry.name, 'GLM-5.3')
    assert.equal(entry.api, 'openai-completions')
    assert.equal(entry.provider, 'zai-coding-cn')
    assert.equal(entry.baseUrl, GLM_52.baseUrl)
    assert.equal(entry.reasoning, true)
    assert.deepEqual(entry.input, ['text'])
    assert.deepEqual(entry.cost, GLM_52.cost)
    assert.deepEqual(entry.compat, GLM_52.compat)
    assert.equal(entry.contextWindow, 1000000)
    assert.equal(entry.maxTokens, 131072)
  })

  it('exposes GLM-5.3 low/high/max thinking levels', () => {
    const entry = buildGlm53Entry(GLM_52)
    assert.deepEqual(entry.thinkingLevelMap, {
      minimal: null, low: 'low', medium: 'high', high: 'high', max: 'max',
    })
    assert.equal(entry.compat.supportsReasoningEffort, true)
  })
})

describe('patchCatalog', () => {
  it('inserts glm-5.3 after glm-5.2 and preserves every other model', () => {
    const result = patchCatalog(catalogWith({
      'glm-5.1': { id: 'glm-5.1', name: 'GLM-5.1' },
      'glm-5.2': GLM_52,
      'glm-5v-turbo': { id: 'glm-5v-turbo', name: 'GLM-5V-Turbo' },
    }))
    assert.equal(result.changed, true)
    assert.deepEqual(Object.keys(result.catalog['openai-completions']), [
      'glm-5.1', 'glm-5.2', 'glm-5.3', 'glm-5v-turbo',
    ])
  })

  it('is idempotent', () => {
    const first = patchCatalog(catalogWith({ 'glm-5.2': GLM_52 }))
    const second = patchCatalog(first.catalog)
    assert.equal(second.changed, false)
    assert.deepEqual(second.catalog, first.catalog)
  })

  it('leaves an upstream glm-5.3 entry alone', () => {
    const foreign = catalogWith({ 'glm-5.2': GLM_52, 'glm-5.3': { id: 'glm-5.3', upstream: true } })
    const result = patchCatalog(foreign)
    assert.equal(result.changed, false)
    assert.deepEqual(result.catalog['openai-completions']['glm-5.3'], foreign['openai-completions']['glm-5.3'])
  })

  it('skips files with no glm-5.2 anchor', () => {
    const catalog = catalogWith({ 'glm-4.7': { id: 'glm-4.7' } })
    const result = patchCatalog(catalog)
    assert.equal(result.changed, false)
    assert.deepEqual(result.catalog, catalog)
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
      writeFileSync(join(dataDir, file), `${JSON.stringify(catalogWith({ 'glm-5.2': glm52 }))}\n`, 'utf8')
    }
    const first = applyToTree(versionsRoot, '0.1.0-rc.6')
    assert.equal(first.length, 2)
    assert.equal(first.every(r => r.changed), true)
    for (const file of ['zai-coding-cn.json', 'zai.json']) {
      const patched = JSON.parse(readFileSync(join(dataDir, file), 'utf8'))
      const entry = patched['openai-completions']['glm-5.3']
      assert.ok(entry)
      assert.equal(entry.thinkingLevelMap.low, 'low')
      assert.equal(entry.compat.supportsReasoningEffort, true)
    }
    const second = applyToTree(versionsRoot, '0.1.0-rc.6')
    assert.equal(second.every(r => !r.changed), true)
  })

  it('reports missing files without throwing', () => {
    const versionsRoot = mkdtempSync(join(tmpdir(), 'dsh-gui-glm53-empty-'))
    tmpDirs.push(versionsRoot)
    const results = applyToTree(versionsRoot, '0.1.0-rc.6')
    assert.equal(results.every(r => !r.changed && r.status === 'missing'), true)
  })
})
