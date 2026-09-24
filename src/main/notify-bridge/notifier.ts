/**
 * 通知管线:信号 → 去重/聚合 → 设置门控 → macOS 原生通知。
 * 去重状态由本类持有;纯逻辑在 dedupe.ts(可测)。
 */

import { Notification } from 'electron'
import type { DshRuntimeError } from '../../shared/contracts'
import type { NotificationSettings } from '../../shared/settings'
import { getLogger } from '../logger'
import {
  emptyApprovalDedupe,
  emptyCompletionAggregate,
  observeApproval,
  observeCompletion,
  resolveApproval,
  type ApprovalDedupeState,
  type CompletionAggregateState
} from './dedupe'
import type { BridgeSignal } from './session-schemas'

const log = getLogger('notifier')

const BODY_MAX = 120

export interface NotifierDeps {
  readonly getSettings: () => NotificationSettings
  readonly isMainWindowVisible: () => boolean
  readonly isNotificationSupported: () => boolean
  readonly onFocusRequested: () => void
}

export class DshNotifier {
  private approvalDedupe: ApprovalDedupeState = emptyApprovalDedupe
  private completionAggregate: CompletionAggregateState = emptyCompletionAggregate

  constructor(private readonly deps: NotifierDeps) {}

  handleSignal(signal: BridgeSignal): void {
    switch (signal.kind) {
      case 'approval-requested': {
        const observed = observeApproval(this.approvalDedupe, signal.approvalId)
        this.approvalDedupe = observed.state
        if (!observed.isDuplicate && this.allowed('approvals')) {
          this.show('需要审批', `${signal.toolName}${signal.reason ? `:${truncate(signal.reason)}` : ''}`)
        }
        return
      }
      case 'approval-resolved': {
        this.approvalDedupe = resolveApproval(this.approvalDedupe, signal.approvalId)
        return
      }
      case 'turn-ended': {
        if (signal.reason === 'completed') {
          if (!this.allowed('turnComplete')) return
          const observed = observeCompletion(this.completionAggregate, signal.sessionId, Date.now())
          this.completionAggregate = observed.state
          if (observed.decision.action === 'notify') this.show('任务完成', `会话 ${signal.sessionId.slice(0, 8)}`)
          return
        }
        if (signal.reason === 'error') {
          if (this.allowed('errors')) this.show('任务失败', truncate(signal.errorMessage ?? `会话 ${signal.sessionId.slice(0, 8)}`))
          return
        }
        if (!this.allowed('turnComplete')) return
        const title = signal.reason === 'aborted' ? '本轮已中止'
          : signal.reason === 'blocked' ? '任务受阻'
            : signal.reason === 'max-tokens' ? '已达输出上限'
              : signal.reason === 'interrupted' ? '运行被中断' : '本轮已结束'
        this.show(title, `会话 ${signal.sessionId.slice(0, 8)}`)
        return
      }
      case 'observer-error': {
        if (this.allowed('errors', true)) this.show('通知监测受限', `会话 ${signal.sessionId.slice(0, 8)} 的事件读取不完整，请查看管理 → 日志`)
        return
      }
      default: {
        const exhaustive: never = signal
        void exhaustive
      }
    }
  }

  /** supervisor 的 NOTIFY_CRASHED(退避耗尽)。 */
  notifyCrashed(error: DshRuntimeError): void {
    if (!this.allowed('errors', true)) {
      return
    }
    this.show('DSH 后端反复退出', truncate(error.message))
  }

  private allowed(kind: 'approvals' | 'turnComplete' | 'errors', bypassHidden = false): boolean {
    const settings = this.deps.getSettings()
    if (!settings[kind]) {
      return false
    }
    if (!bypassHidden && settings.onlyWhenHidden && this.deps.isMainWindowVisible()) {
      return false
    }
    return true
  }

  private show(title: string, body: string): void {
    if (!this.deps.isNotificationSupported()) {
      log.warn('notification not supported on this system', { title })
      return
    }
    const notification = new Notification({ title, body })
    notification.on('click', () => {
      this.deps.onFocusRequested()
    })
    notification.show()
    log.info('notification shown', { title })
  }
}

function truncate(text: string, max = BODY_MAX): string {
  const firstLine = text.split('\n')[0] ?? text
  return firstLine.length > max ? `${firstLine.slice(0, max)}…` : firstLine
}
