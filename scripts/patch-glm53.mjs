#!/usr/bin/env node
/**
 * 向内置运行时的 pi-ai 模型目录注入 GLM-5.3(智谱 Coding Plan 当前旗舰)。
 *
 * 为什么存在:dsh 0.1.0-rc.6 携带的 @earendil-works/pi-ai 目录只收录到 glm-5.2。
 * 上游目录更新要等 dsh 发新版,而 GUI 内置树是按锁定版本 npm 物化的,所以在这层
 * 做一个幂等数据补丁:克隆 glm-5.2 条目、只换身份与思考档映射。数据补丁不碰任何
 * 代码路径,风险面为零;将来上游目录自己收录 glm-5.3 后,本补丁检测到同名条目即
 * 静默让位(见 patchCatalog 的 foreign 分支),不会与上游打架。
 *
 * 上次的教训(另一台 Mac):手动加 glm-5.3 时照了 glm-5.1 的样子,丢掉
 * compat.supportsReasoningEffort 和 thinkingLevelMap,选 5.3 后思考档选择器消失、
 * 状态栏统计残缺。所以本补丁强制从 glm-5.2 克隆全部字段——那是已被验证带着完整
 * 状态栏(缓存命中等)工作的条目——只覆盖三处:
 *   - id/name → glm-5.3 / GLM-5.3
 *   - thinkingLevelMap → 官方 5.3 档位:思考常开,支持 low/high/max,不再支持关闭;
 *     minimal 仍标记不支持(5.2 同款形态,无 off 键)
 *
 * 官方依据(docs.bigmodel.cn/cn/guide/models/text/glm-5.3 与 /cn/coding-plan/faq):
 * Coding Plan 全套餐支持 GLM-5.3;1M 上下文;最大输出 128K;上下文缓存开启;
 * 模型 API low/high/max 三档,默认 max。
 *
 * 用法:被 fetch-builtin-runtime.mjs 在物化前后调用;也可单独执行
 * `node scripts/patch-glm53.mjs` 修补本机两棵运行时树(darwin + win32)。
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 补丁针对的两个目录文件:国内 Coding Plan 与国际 z.ai 端点。 */
const CATALOG_FILES = ['zai-coding-cn.json', 'zai.json']

/** 克隆锚点:5.3 的全部字段来源。 */
const GLM_52_ID = 'glm-5.2'

/** 补丁目标。 */
export const GLM_53_ID = 'glm-5.3'

/** pi-ai 模型目录数据文件在运行时树内的位置。 */
export const PROVIDER_DATA_RELATIVE = join(
  'node_modules',
  '@earendil-works',
  'pi-ai',
  'dist',
  'providers',
  'data',
)

/**
 * 由 glm-5.2 条目构建 glm-5.3 条目。
 *
 * 整体克隆而非挑选字段:目录条目里 compat(thinkingFormat/zaiToolStream)、cost、
 * contextWindow 等每一个字段都有下游消费者,逐字段重写等于把「上次丢字段」的
 * 事故面原样保留。克隆 + 显式覆盖差异,未知的字段自动跟上 5.2。
 *
 * @param {Record<string, unknown>} glm52 - 目录里的 glm-5.2 条目。
 * @returns {Record<string, unknown>} glm-5.3 条目。
 */
export function buildGlm53Entry(glm52) {
  return Object.freeze({
    ...glm52,
    id: GLM_53_ID,
    name: 'GLM-5.3',
    thinkingLevelMap: Object.freeze({ minimal: null, low: 'low', medium: 'high', high: 'high', max: 'max' }),
  })
}

/**
 * 补丁一个已解析的目录对象(纯函数)。
 *
 * 规则:
 * - 无 glm-5.2 锚点 → 原样返回(不动无法验证的文件);
 * - 已存在 glm-5.3(含上游将来自带的)→ 原样返回,永不覆盖;
 * - 否则在 glm-5.2 之后插入(下拉列表保持 5.1/5.2/5.3/5V 的自然顺序)。
 *
 * @param {Record<string, any>} catalog - provider 数据文件解析结果。
 * @returns {{ catalog: Record<string, any>, changed: boolean }}
 */
export function patchCatalog(catalog) {
  const models = catalog?.['openai-completions']
  if (models === undefined || typeof models !== 'object' || models === null) {
    return { catalog, changed: false }
  }
  if (models[GLM_52_ID] === undefined) return { catalog, changed: false }
  if (models[GLM_53_ID] !== undefined) return { catalog, changed: false }

  const entry = buildGlm53Entry(models[GLM_52_ID])
  const next = {}
  for (const [key, value] of Object.entries(models)) {
    next[key] = value
    if (key === GLM_52_ID) next[GLM_53_ID] = entry
  }
  return { catalog: { ...catalog, 'openai-completions': next }, changed: true }
}

/**
 * 补丁一棵运行时树(`<versionsRoot>/<version>/`)里的 zai 目录文件。
 *
 * @param {string} versionsRoot - 运行时版本根目录(resources/dsh-runtime 或 dsh-runtime-win)。
 * @param {string} version - 形如 0.1.0-rc.6 的目录名。
 * @returns {Array<{ file: string, status: 'patched' | 'missing' | 'skipped', changed: boolean }>}
 */
export function applyToTree(versionsRoot, version) {
  const results = []
  for (const file of CATALOG_FILES) {
    const path = join(versionsRoot, version, PROVIDER_DATA_RELATIVE, file)
    if (!existsSync(path)) {
      results.push({ file, status: 'missing', changed: false })
      continue
    }
    const catalog = JSON.parse(readFileSync(path, 'utf8'))
    const { catalog: next, changed } = patchCatalog(catalog)
    if (changed) {
      // 数据文件是单行压缩 JSON + 换行,保持原格式回写。
      writeFileSync(path, `${JSON.stringify(next)}\n`, 'utf8')
      results.push({ file, status: 'patched', changed: true })
    } else {
      results.push({ file, status: 'skipped', changed: false })
    }
  }
  return results
}

/**
 * 扫描版本根目录,对每个真实版本目录(排除 tmp-* 与 *.old-* 备份)应用补丁。
 *
 * 扫描而非硬编码版本号:运行时版本升级后无需同步改这里;备份目录不动,保持可回滚。
 *
 * @param {string} versionsRoot - 运行时版本根目录。
 * @returns {Array<{ file: string, status: string, changed: boolean }>}
 */
export function patchVersionsRoot(versionsRoot) {
  const results = []
  if (!existsSync(versionsRoot)) return results
  for (const name of readdirSync(versionsRoot)) {
    if (name.startsWith('tmp-') || name.includes('.old-')) continue
    results.push(...applyToTree(versionsRoot, name))
  }
  return results
}

/** 独立执行时修补本机两棵运行时树。 */
function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  for (const runtimeDir of ['dsh-runtime', 'dsh-runtime-win']) {
    const results = patchVersionsRoot(join(root, 'resources', runtimeDir))
    for (const r of results) {
      console.log(`${runtimeDir}: ${r.file} ${r.changed ? 'patched (glm-5.3 added)' : r.status}`)
    }
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main()
}
