/** error 视图:错误详情 + 动作(重启/停止/管理/日志/退出)。 */

import { getApi } from '../lib/api'
import { button, el } from '../lib/dom'

export function mountError(container: HTMLElement): () => void {
  const title = el('h1', {}, 'DSH 后端未在运行')
  const message = el('p', { class: 'status' })
  const tail = el('pre', { class: 'stdio-tail' })
  const actions = el('div', { class: 'actions' })

  const render = (): void => {
    void getApi().getState().then((snapshot) => {
      message.textContent =
        snapshot.lastError !== null
          ? snapshot.lastError.message
          : snapshot.state === 'stopped'
            ? '后端已停止。可点击「重启后端」再次启动。'
            : `当前状态:${snapshot.state}`
      tail.textContent = snapshot.lastError?.stdioTail.join('\n') ?? ''
    })
  }

  actions.append(
    button('重启后端', () => {
      void getApi().restartRuntime()
      window.location.hash = '#loading'
    }, { primary: true }),
    button('版本管理…', () => {
      void getApi().openManageWindow()
    }),
    button('打开日志', () => {
      void getApi().openLogsFolder()
    }),
    button('退出 DSH GUI', () => {
      void getApi().quitApp()
    })
  )

  container.append(
    el(
      'div',
      { class: 'center-page' },
      el('div', { class: 'error-icon' }, '⚠'),
      title,
      message,
      tail,
      actions
    )
  )

  const unsubscribe = getApi().onState(() => {
    render()
  })
  render()

  return unsubscribe
}
