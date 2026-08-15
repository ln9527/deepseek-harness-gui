/** loading 视图:状态文案 + 重启倒计时(500ms 刷新)。 */

import type { DshRuntimeSnapshot } from '../../../shared/contracts'
import { getApi } from '../lib/api'
import { el } from '../lib/dom'

export function mountLoading(container: HTMLElement): () => void {
  const statusText = el('p', { class: 'status' }, '正在启动 DSH…')
  const detailText = el('p', { class: 'detail' })
  container.append(
    el(
      'div',
      { class: 'center-page' },
      el('div', { class: 'spinner' }),
      statusText,
      detailText
    )
  )

  const render = (snapshot: DshRuntimeSnapshot): void => {
    const texts: Readonly<Record<string, string>> = {
      idle: '等待启动…',
      starting: '正在启动 DSH…',
      ready: '已就绪,即将进入…',
      restarting: 'DSH 异常退出,准备重启…',
      stopping: '正在停止 DSH…',
      stopped: 'DSH 已停止'
    }
    statusText.textContent = texts[snapshot.state] ?? snapshot.state
    const parts: string[] = []
    if (snapshot.version !== null) {
      parts.push(`版本 ${snapshot.version}`)
    }
    if (snapshot.restartAttempt > 0) {
      parts.push(`第 ${snapshot.restartAttempt} 次重试`)
    }
    if (snapshot.nextRestartAtMs !== null) {
      const remain = Math.max(0, Math.ceil((snapshot.nextRestartAtMs - Date.now()) / 1000))
      parts.push(`${remain}s 后重启`)
    }
    detailText.textContent = parts.join(' · ')
  }

  const unsubscribe = getApi().onState(render)
  const timer = setInterval(() => {
    void getApi().getState().then(render)
  }, 500)
  void getApi().getState().then(render)

  return () => {
    unsubscribe()
    clearInterval(timer)
  }
}
