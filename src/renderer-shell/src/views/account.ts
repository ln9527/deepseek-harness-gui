import type { DesktopAuthState, DesktopProjectCardsState } from '../../../shared/desktop-auth'
import { getApi, resultError } from '../lib/api'
import { button, clear, el } from '../lib/dom'

/** Shell-owned connection UI. The embedded DSH page never sees this identity. */
export function renderAccount(content: HTMLElement): () => void {
  const api = getApi()
  const body = el('section', { class: 'account-panel' })
  const feedback = el('p', { class: 'status', role: 'status' })
  content.append(el('h2', {}, '组织连接'), el('p', { class: 'detail' }, '本地工作台可以离线使用。连接时可选择只读项目卡授权；文件或对话不会自动上传。'), body, feedback)
  let alive = true
  let current: DesktopAuthState | null = null
  let lastRefreshAt = 0
  let cardsRevision = 0

  const showError = (result: { ok: boolean; error?: { message: string } }): void => {
    feedback.textContent = resultError(result)
  }

  const restartPairing = (): void => {
    feedback.textContent = '正在断开并取得新的连接码…'
    void api.disconnectDesktopAuth().then(async (disconnected) => {
      if (!disconnected.ok && disconnected.error.code !== 'REMOTE_REVOKE_UNCONFIRMED') {
        showError(disconnected)
        return
      }
      const started = await api.startDesktopAuth()
      showError(started)
      if (started.ok && !disconnected.ok) feedback.textContent = disconnected.error.message
      if (started.ok) render(started.value)
    })
  }

  const showCards = (host: HTMLElement, result: DesktopProjectCardsState, revision: number): void => {
    if (!alive || revision !== cardsRevision || current?.status !== 'connected') return
    clear(host)
    if (result.status === 'ready') {
      if (result.projects.length === 0) {
        host.append(el('p', { class: 'hint' }, '目前没有你可读取的组织项目。'))
      } else {
        const list = el('ul', { class: 'project-card-list' })
        for (const card of result.projects) {
          const role = card.role === 'owner' ? '负责人' : card.role === 'member' ? '成员' : '管理员'
          list.append(el('li', { class: 'project-card' },
            el('strong', {}, card.title),
            el('span', { class: 'project-card-meta' }, `负责人 ${card.owner} · 我的角色 ${role} · 更新于 ${new Date(card.updatedAt).toLocaleString('zh-CN')}`)))
        }
        host.append(list)
      }
      host.append(el('p', { class: 'hint' }, '只显示当前可读项目的元数据；权限变化会在下次读取时生效。'))
      return
    }
    if (result.status === 'no-grant' || result.status === 'reauthorize') {
      host.append(el('p', { class: 'hint' }, result.status === 'no-grant'
        ? '这台设备还没有项目卡授权。要查看项目卡，请重新连接并在浏览器确认页主动勾选。'
        : '项目卡授权已失效，列表已隐藏。请重新连接并在浏览器确认页再次勾选。'),
      button('断开并重新授权', restartPairing))
      return
    }
    host.append(el('p', { class: 'hint' }, '项目卡暂时无法验证，列表已隐藏。联网后可重试。'),
      button('重试项目卡', () => { void loadCards(host, revision) }))
  }

  const loadCards = async (host: HTMLElement, revision: number): Promise<void> => {
    if (!alive || revision !== cardsRevision || current?.status !== 'connected') return
    clear(host)
    host.append(el('p', { class: 'hint' }, '正在验证项目卡权限…'))
    try {
      showCards(host, await api.getDesktopProjectCards(), revision)
    } catch {
      showCards(host, { status: 'unavailable' }, revision)
    }
  }

  const render = (state: DesktopAuthState): void => {
    if (!alive) return
    const revision = ++cardsRevision
    current = state
    clear(body)
    switch (state.status) {
      case 'disconnected': {
        body.append(
          el('p', {}, '未连接组织账号'),
          button('连接组织账号', () => {
            feedback.textContent = '正在取得一次性连接码…'
            void api.startDesktopAuth().then((result) => {
              showError(result)
              if (result.ok) render(result.value)
            })
          }, { primary: true })
        )
        break
      }
      case 'pending': {
        body.append(
          el('p', {}, '在系统浏览器中登录组织账号，并输入下面的连接码。首次登录需要先修改初始密码。'),
          el('div', { class: 'device-code' }, state.userCode),
          el('p', { class: 'hint' }, `有效期至 ${new Date(state.expiresAt).toLocaleTimeString('zh-CN', { hour12: false })}。请在网页核对设备名称并确认。`),
          el('p', { class: 'verification-url' }, state.verificationUrl),
          el('div', { class: 'row' },
            button('打开验证页', () => { void api.openDesktopVerification().then(showError) }),
            button('取消连接', () => { void api.cancelDesktopAuth().then(showError) })
          )
        )
        break
      }
      case 'connected':
      case 'offline': {
        const offline = state.status === 'offline'
        const cards = el('section', { class: 'project-cards' },
          el('h3', {}, '我的组织项目卡'))
        const cardsBody = el('div', { class: 'project-cards-body' })
        cards.append(cardsBody)
        body.append(
          el('p', { class: offline ? 'account-state offline' : 'account-state connected' }, offline ? '组织连接待验证 · 当前离线' : '已连接组织账号'),
          el('p', {}, `账号：${state.user.username}`),
          el('p', { class: 'hint' }, state.saved ? '凭据已由系统安全存储；设备连接最长 14 天，到期或组织撤销后需重新连接。' : '系统安全存储不可用，关闭应用后需要重新连接。'),
          el('div', { class: 'row' },
            offline ? button('重试验证', () => { void api.refreshDesktopAuth().then(showError) }) : null,
            button('在浏览器管理设备', () => { void api.openDesktopDeviceManagement().then(showError) }),
            button('断开组织连接', () => {
              feedback.textContent = '正在断开…'
              void api.disconnectDesktopAuth().then(showError)
            })
          ),
          cards
        )
        if (offline) cardsBody.append(el('p', { class: 'hint' }, '当前离线，项目卡已隐藏；联网后重试验证。'))
        else void loadCards(cardsBody, revision)
        break
      }
      case 'error': {
        body.append(
          el('p', { class: 'account-state offline' }, state.message),
          el('div', { class: 'row' },
            button('重新连接', () => {
              feedback.textContent = '正在取得新连接码…'
              void api.startDesktopAuth().then((result) => {
                showError(result)
                if (result.ok) render(result.value)
              })
            }, { primary: true }),
            button('清除本机连接', () => { void api.disconnectDesktopAuth().then(showError) })
          )
        )
      }
    }
  }

  // A device may be revoked or expire while the local DSH stays open. Check on
  // account entry/focus and every five minutes while this tab is mounted.
  const revalidate = (): void => {
    if (!alive || (current?.status !== 'connected' && current?.status !== 'offline')) return
    const now = Date.now()
    if (now - lastRefreshAt < 60_000) return
    lastRefreshAt = now
    void api.refreshDesktopAuth().then(showError)
  }
  let receivedPush = false
  const unsubscribe = api.onDesktopAuthChanged((state) => { receivedPush = true; render(state) })
  void api.getDesktopAuth().then((state) => {
    if (!receivedPush) render(state)
    revalidate()
  })
  window.addEventListener('focus', revalidate)
  const timer = window.setInterval(revalidate, 5 * 60_000)
  return () => {
    alive = false
    unsubscribe()
    window.removeEventListener('focus', revalidate)
    window.clearInterval(timer)
  }
}
