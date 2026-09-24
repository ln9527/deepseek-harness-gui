import type { DesktopAuthState } from '../../../shared/desktop-auth'
import { getApi, resultError } from '../lib/api'
import { button, clear, el } from '../lib/dom'

/** Shell-owned connection UI. The embedded DSH page never sees this identity. */
export function renderAccount(content: HTMLElement): () => void {
  const api = getApi()
  const body = el('section', { class: 'account-panel' })
  const feedback = el('p', { class: 'status', role: 'status' })
  content.append(el('h2', {}, '组织连接'), el('p', { class: 'detail' }, '本地工作台可以离线使用。连接后这里只验证组织身份；文件或对话不会自动上传。'), body, feedback)
  let alive = true

  const showError = (result: { ok: boolean; error?: { message: string } }): void => {
    feedback.textContent = resultError(result)
  }

  const render = (state: DesktopAuthState): void => {
    if (!alive) return
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
          )
        )
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

  void api.getDesktopAuth().then(render)
  const unsubscribe = api.onDesktopAuthChanged(render)
  return () => { alive = false; unsubscribe() }
}
