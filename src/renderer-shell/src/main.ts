/** 壳 UI 入口:hash 路由(#loading / #error / #setup / #manage[/tab])。 */

import { mountLoading } from './views/loading'
import { mountError } from './views/error'
import { mountSetup } from './views/setup'
import { mountManage } from './views/manage'
import { clear, el } from './lib/dom'
import './styles.css'

const appCandidate = document.querySelector<HTMLElement>('#app')
if (!appCandidate) {
  throw new Error('#app 容器缺失')
}
const app: HTMLElement = appCandidate

let cleanup: (() => void) | null = null

function route(): void {
  // 二级 hash:如 #manage/settings → name='#manage', sub='settings'
  const [name, sub] = (window.location.hash || '#loading').split('/')
  cleanup?.()
  cleanup = null
  clear(app)
  app.append(el('div', { class: 'shell-page', 'data-view': name }))
  const page = app.querySelector<HTMLElement>('.shell-page')
  if (!page) {
    return
  }
  switch (name) {
    case '#error':
      cleanup = mountError(page)
      break
    case '#setup':
      cleanup = mountSetup(page)
      break
    case '#manage':
      cleanup = mountManage(page, sub)
      break
    default:
      cleanup = mountLoading(page)
  }
}

window.addEventListener('hashchange', route)
route()
