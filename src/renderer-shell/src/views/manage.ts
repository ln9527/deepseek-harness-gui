/** manage 视图:版本面板 / 设置 / 日志 / 关于。 */

import type { DshVersionInfo, InstallProgress } from '../../../shared/ipc-types'
import { DEEPSEEK_ENV_KEYS, type ShellSettings } from '../../../shared/settings'
import { getApi } from '../lib/api'
import { button, clear, el } from '../lib/dom'

type TabId = 'versions' | 'settings' | 'logs' | 'about'

const VALID_TABS: readonly TabId[] = ['versions', 'settings', 'logs', 'about']

export function mountManage(container: HTMLElement, initialSub?: string): () => void {
  const api = getApi()
  const nav = el('nav', { class: 'tabs' })
  const content = el('div', { class: 'tab-content' })
  container.append(el('div', { class: 'manage' }, nav, content))

  const tabs: ReadonlyArray<{ readonly id: TabId; readonly label: string }> = [
    { id: 'versions', label: '版本' },
    { id: 'settings', label: '设置' },
    { id: 'logs', label: '日志' },
    { id: 'about', label: '关于' }
  ]
  const initial = VALID_TABS.find((t) => t === initialSub)
  let currentTab: TabId = initial ?? 'versions'
  let tabCleanup: (() => void) | null = null

  const activate = (id: TabId): void => {
    currentTab = id
    for (const btn of [...nav.children]) {
      btn.classList.toggle('active', (btn as HTMLElement).dataset.tab === id)
    }
    tabCleanup?.()
    tabCleanup = null
    clear(content)
    switch (id) {
      case 'versions':
        tabCleanup = renderVersions(content)
        break
      case 'settings':
        tabCleanup = renderSettings(content)
        break
      case 'logs':
        tabCleanup = renderLogs(content)
        break
      case 'about':
        tabCleanup = renderAbout(content)
        break
    }
  }

  for (const tab of tabs) {
    const btn = el('button', { class: 'tab', 'data-tab': tab.id }, tab.label)
    btn.addEventListener('click', () => {
      activate(tab.id)
    })
    nav.append(btn)
  }
  activate(currentTab)

  const unsubscribeProgress = api.onInstallProgress((p) => {
    if (currentTab === 'versions') {
      tabCleanup?.()
      tabCleanup = renderVersions(content, p)
    }
  })

  return () => {
    unsubscribeProgress()
    tabCleanup?.()
  }
}

// ---- 版本 tab ----

function renderVersions(content: HTMLElement, progress?: InstallProgress): () => void {
  const api = getApi()
  const list = el('div', { class: 'version-list' })
  const installRow = el('div', { class: 'row' })
  const select = el('select', { class: 'select' }) as HTMLSelectElement
  const installBtn = button('安装其他版本', () => {
    const result = api.installVersion({ version: select.value })
    void result.then((r) => {
      if (!r.ok) {
        progressPhase.textContent = r.error.message
      }
    })
  })
  const progressPhase = el('p', { class: 'status' })

  content.append(
    el('h2', {}, 'DSH 版本'),
    list,
    el('h3', {}, '安装其他版本'),
    installRow,
    progressPhase
  )
  installRow.append(select, installBtn)

  const renderList = (versions: readonly DshVersionInfo[]): void => {
    clear(list)
    if (versions.length === 0) {
      list.append(el('p', { class: 'hint' }, '尚未安装任何版本'))
      return
    }
    for (const v of versions) {
      const meta: string[] = []
      if (v.builtin) {
        meta.push('随应用内置')
      } else if (v.installedAt !== null) {
        meta.push(new Date(v.installedAt).toLocaleString())
      }
      const actions = el('div', { class: 'row' })
      if (!v.active) {
        actions.append(
          button('切换到此版本', () => {
            void api.selectVersion({ version: v.version }).then((r) => {
              if (!r.ok) {
                progressPhase.textContent = r.error.message
              }
            })
          })
        )
        if (!v.builtin) {
          actions.append(
            button('删除', () => {
              void api.removeVersion({ version: v.version }).then((r) => {
                progressPhase.textContent = r.ok ? `已删除 ${v.version}` : r.error.message
                if (r.ok) {
                  void refresh()
                }
              })
            })
          )
        }
      }
      list.append(
        el(
          'div',
          { class: `version-item${v.active ? ' active' : ''}` },
          el('div', {},
            el('strong', {}, v.version),
            v.active ? el('span', { class: 'badge' }, '当前运行') : null,
            v.builtin ? el('span', { class: 'badge builtin' }, '内置') : null,
            el('span', { class: 'meta' }, meta.join(' · '))),
          actions
        )
      )
    }
  }

  const refresh = async (): Promise<void> => {
    renderList(await api.listVersions())
  }
  void refresh()

  void api.listRegistry().then((result) => {
    if (!result.ok) {
      select.disabled = true
      installBtn.disabled = true
      select.append(el('option', {}, `registry 不可用:${result.error.message}`))
      return
    }
    void api.listVersions().then((installed) => {
      const installedSet = new Set(installed.map((v) => v.version))
      for (const version of [...result.value.versions].reverse()) {
        if (!installedSet.has(version)) {
          select.append(el('option', { value: version }, version))
        }
      }
      if (select.options.length === 0) {
        select.disabled = true
        installBtn.disabled = true
        select.append(el('option', {}, '所有可用版本均已安装'))
      }
    })
  })

  if (progress !== undefined) {
    if (progress.phase === 'error') {
      progressPhase.textContent = `安装失败:${progress.error ?? ''}`
    } else if (progress.phase === 'done') {
      progressPhase.textContent = `已安装 ${progress.version}`
      void refresh()
    } else {
      progressPhase.textContent = `正在安装 ${progress.version}(${progress.phase})…`
      installBtn.disabled = true
    }
  }

  return () => {}
}

// ---- 设置 tab ----

function renderSettings(content: HTMLElement): () => void {
  const api = getApi()
  const form = el('div', { class: 'settings' })

  const render = (settings: ShellSettings): void => {
    clear(form)
    const mkCheck = (label: string, checked: boolean, onChange: (v: boolean) => void): HTMLElement => {
      const input = el('input', { type: 'checkbox' }) as HTMLInputElement
      input.checked = checked
      input.addEventListener('change', () => {
        onChange(input.checked)
      })
      return el('label', { class: 'check' }, input, ` ${label}`)
    }
    const apply = (patch: Parameters<typeof api.setSettings>[0]): void => {
      void api.setSettings(patch).then(() => {
        renderStatus.textContent = '已保存'
      })
    }
    const renderStatus = el('span', { class: 'meta' })

    form.append(
      el('h2', {}, '设置'),
      el('h3', {}, '启动'),
      mkCheck('开机自启', settings.launch.openAtLogin, (v) => {
        apply({ launch: { openAtLogin: v } })
      }),
      mkCheck('启动时隐藏窗口(仅托盘)', settings.launch.startHidden, (v) => {
        apply({ launch: { startHidden: v } })
      }),
      mkCheck('DSH 崩溃后自动重启', settings.autoRestart, (v) => {
        apply({ autoRestart: v })
      }),
      el('h3', {}, '通知'),
      mkCheck('审批请求通知', settings.notifications.approvals, (v) => {
        apply({ notifications: { approvals: v } })
      }),
      mkCheck('任务完成通知', settings.notifications.turnComplete, (v) => {
        apply({ notifications: { turnComplete: v } })
      }),
      mkCheck('错误通知', settings.notifications.errors, (v) => {
        apply({ notifications: { errors: v } })
      }),
      mkCheck('仅当窗口隐藏时提醒', settings.notifications.onlyWhenHidden, (v) => {
        apply({ notifications: { onlyWhenHidden: v } })
      }),
      el('h3', {}, 'DeepSeek'),
      mkDeepseekSection(settings, apply),
      el('h3', {}, '运行时(高级)'),
      mkAdvanced(settings, apply),
      renderStatus
    )
  }

  /** DeepSeek API Key / Base URL 一等字段:本体存 runtime.extraEnv,保存时保留其他键。 */
  const mkDeepseekSection = (
    settings: ShellSettings,
    apply: (patch: Parameters<typeof api.setSettings>[0]) => void
  ): HTMLElement => {
    const keyInput = el('input', { type: 'password', autocomplete: 'off', class: 'input', placeholder: 'sk-…' }) as HTMLInputElement
    keyInput.value = settings.runtime.extraEnv[DEEPSEEK_ENV_KEYS.apiKey] ?? ''
    const urlInput = el('input', { type: 'text', class: 'input', placeholder: 'https://api.deepseek.com(可选)' }) as HTMLInputElement
    urlInput.value = settings.runtime.extraEnv[DEEPSEEK_ENV_KEYS.baseUrl] ?? ''
    const saveBtn = button('保存 DeepSeek 配置', () => {
      const others = Object.fromEntries(
        Object.entries(settings.runtime.extraEnv).filter(
          ([k]) => k !== DEEPSEEK_ENV_KEYS.apiKey && k !== DEEPSEEK_ENV_KEYS.baseUrl
        )
      )
      const key = keyInput.value.trim()
      const url = urlInput.value.trim()
      apply({
        runtime: {
          dshHomeOverride: settings.runtime.dshHomeOverride,
          extraEnv: {
            ...others,
            ...(key.length > 0 ? { [DEEPSEEK_ENV_KEYS.apiKey]: key } : {}),
            ...(url.length > 0 ? { [DEEPSEEK_ENV_KEYS.baseUrl]: url } : {})
          }
        }
      })
    })
    return el(
      'div',
      { class: 'advanced' },
      el('p', { class: 'hint' }, '保存后重启后端生效;留空即删除。也可改用 DSH Web UI 的 Models 页配置(存 ~/.dsh)。'),
      el('label', {}, 'API Key'),
      keyInput,
      el('label', {}, 'Base URL(可选)'),
      urlInput,
      saveBtn
    )
  }

  const mkAdvanced = (
    settings: ShellSettings,
    apply: (patch: Parameters<typeof api.setSettings>[0]) => void
  ): HTMLElement => {
    const envText = Object.entries(settings.runtime.extraEnv)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')
    const homeInput = el('input', { type: 'text', class: 'input', placeholder: '默认 ~/.dsh' }) as HTMLInputElement
    homeInput.value = settings.runtime.dshHomeOverride ?? ''
    const envArea = el('textarea', { class: 'textarea', rows: '3', placeholder: 'DEEPSEEK_API_KEY=sk-…' }) as HTMLTextAreaElement
    envArea.value = envText
    const saveBtn = button('保存高级设置', () => {
      const extraEnv: Record<string, string> = {}
      for (const line of envArea.value.split('\n')) {
        const trimmed = line.trim()
        if (trimmed.length === 0) {
          continue
        }
        const eq = trimmed.indexOf('=')
        if (eq <= 0) {
          continue
        }
        extraEnv[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1)
      }
      const home = homeInput.value.trim()
      apply({
        runtime: {
          dshHomeOverride: home.length > 0 ? home : null,
          extraEnv
        }
      })
    })
    return el(
      'div',
      { class: 'advanced' },
      el('p', { class: 'hint' }, '从 Finder/Dock 启动时不继承 shell 环境变量;可在此注入(如 API Key),或直接在 DSH Web UI 里配置凭据。'),
      el('label', {}, 'DSH_HOME 覆盖路径'),
      homeInput,
      el('label', {}, '额外环境变量(每行 KEY=VALUE)'),
      envArea,
      saveBtn
    )
  }

  content.append(form)
  void api.getSettings().then(render)
  const unsubscribe = api.onSettingsChanged(render)
  return unsubscribe
}

// ---- 日志 tab ----

function renderLogs(content: HTMLElement): () => void {
  const api = getApi()
  const pre = el('pre', { class: 'log-view' })
  const refreshBtn = button('刷新', () => {
    void refresh()
  })
  const openBtn = button('打开日志文件夹', () => {
    void api.openLogsFolder()
  })
  content.append(
    el('h2', {}, '日志'),
    el('div', { class: 'row' }, refreshBtn, openBtn),
    pre
  )
  const refresh = async (): Promise<void> => {
    const lines = await api.getLogTail({ maxLines: 500 })
    pre.textContent = lines.join('\n') || '(暂无日志)'
    pre.scrollTop = pre.scrollHeight
  }
  void refresh()
  return () => {}
}

// ---- 关于 tab ----

function renderAbout(content: HTMLElement): () => void {
  content.append(
    el('h2', {}, '关于 DSH GUI'),
    el('p', { class: 'detail' }, 'DeepSeek Harness (DSH) 的 macOS 桌面壳:进程管理 + 官方 Web UI + 托盘与原生通知。'),
    el('ul', { class: 'notes' },
      el('li', {}, '壳不修改 DSH;升级 DSH 只需在「版本」页安装并切换'),
      el('li', {}, '应用内置版本只读,可在版本页安装并切换到新版本'),
      el('li', {}, '会话与凭据由 DSH 自身管理(~/.dsh)'),
      el('li', {}, '问题排查:菜单「管理 → 日志」'))
  )
  return () => {}
}
