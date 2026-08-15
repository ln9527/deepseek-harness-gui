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
import type { BridgeSignal } from './ws-frame-schemas'

const log = getLogger('notifier')

const BODY_MAX = 120

export interface NotifierDeps {
  readonly getSettings: () => NotificationSettings
  readonly isMainWindowVisible: () => boolean
  readonly isNotificationSupported: () => boolean
  readonly onFocusRequested: () => void
}

/** 会话运行状态缓存:running true→false = 一个 turn 完成。 */
type RunningMap = Readonly<Record<string, boolean>>

export class DshNotifier {
  private approvalDedupe: ApprovalDedupeState = emptyApprovalDedupe
  private completionAggregate: CompletionAggregateState = emptyCompletionAggregate
  private runningMap: RunningMap = {}

  constructor(private readonly deps: NotifierDeps) {}

  handleSignal(signal: Exclude<BridgeSignal, { kind: 'ignored' }>): void {
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
      case 'session-status': {
        const wasRunning = this.runningMap[signal.sessionId] === true
        this.runningMap = { ...this.runningMap, [signal.sessionId]: signal.running }
        if (wasRunning && !signal.running && this.allowed('turnComplete')) {
          const observed = observeCompletion(this.completionAggregate, signal.sessionId, Date.now())
          this.completionAggregate = observed.state
          if (observed.decision.action === 'notify') {
            this.show('任务完成', `会话 ${signal.sessionId.slice(0, 8)}`)
          }
        }
        return
      }
      case 'agent-error': {
        if (this.allowed('errors')) {
          this.show('Agent 出错', truncate(signal.message))
        }
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
