/** setup 视图:首装向导(版本选择 + 安装进度 + env 提示)。 */

import type { InstallProgress } from '../../../shared/ipc-types'
import { getApi } from '../lib/api'
import { button, el } from '../lib/dom'

export function mountSetup(container: HTMLElement): () => void {
  const api = getApi()

  const versionSelect = el('select', { class: 'select' }) as HTMLSelectElement
  const installBtn = button('下载并安装', () => {
    void install()
  }, { primary: true })
  const progressPhase = el('p', { class: 'status' })
  const progressLine = el('pre', { class: 'stdio-tail' })
  const envHint = el('p', { class: 'hint' })

  container.append(
    el(
      'div',
      { class: 'center-page setup' },
      el('h1', {}, '欢迎使用 DSH GUI'),
      el(
        'p',
        { class: 'detail' },
        'DSH GUI 是 DeepSeek Harness 的 macOS 桌面壳。未随应用内置 DSH 时,首次使用需要下载安装:'
      ),
      el('ul', { class: 'notes' },
        el('li', {}, '下载约 47 MB,安装后占用约 350 MB 磁盘(装在本应用数据目录)'),
        el('li', {}, '模型凭据可在「管理 → 设置」直接填写,或在 DSH Web UI 的 Models 页配置')),
      el('div', { class: 'row' }, versionSelect, installBtn),
      progressPhase,
      progressLine,
      envHint
    )
  )

  let installing = false

  async function install(): Promise<void> {
    if (installing) {
      return
    }
    const version = versionSelect.value
    const result = await api.installVersion({ version })
    if (!result.ok) {
      progressPhase.textContent = `无法开始安装:${result.error.message}`
      return
    }
    installing = true
    installBtn.disabled = true
    progressPhase.textContent = '准备下载…'
  }

  const renderProgress = (p: InstallProgress): void => {
    if (p.phase === 'done') {
      progressPhase.textContent = '安装完成,正在启动 DSH…'
      progressLine.textContent = ''
      return
    }
    if (p.phase === 'error') {
      progressPhase.textContent = '安装失败,可重试'
      progressLine.textContent = p.error ?? ''
      installing = false
      installBtn.disabled = false
      return
    }
    const phaseText: Readonly<Record<string, string>> = {
      resolving: '正在解析依赖…',
      downloading: '正在下载(约 47 MB)…',
      installing: '正在安装依赖(可能需要几分钟)…',
      finalizing: '正在完成安装…'
    }
    progressPhase.textContent = phaseText[p.phase] ?? p.phase
    if (p.lastLine !== null && p.lastLine.length > 0) {
      progressLine.textContent = p.lastLine
    }
  }

  void api.listRegistry().then((result) => {
    if (!result.ok) {
      versionSelect.disabled = true
      installBtn.disabled = true
      progressPhase.textContent = `无法获取版本列表:${result.error.message}(检查本机 npm 与网络)`
      return
    }
    const reversed = [...result.value.versions].reverse()
    for (const version of reversed) {
      const option = el('option', { value: version }, version)
      if (version === result.value.latest) {
        option.selected = true
      }
      versionSelect.append(option)
    }
  })

  void api.getEnvHint().then((hint) => {
    if (!hint.hasDeepseekApiKey) {
      envHint.textContent =
        '提示:未检测到 DeepSeek API Key。安装后可在「管理 → 设置」直接填写,或在 DSH Web UI 的 Models 页配置。'
    }
  })

  const unsubscribe = api.onInstallProgress(renderProgress)
  return unsubscribe
}
