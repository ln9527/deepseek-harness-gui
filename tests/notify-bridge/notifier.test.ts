import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DshNotifier } from '../../src/main/notify-bridge/notifier'

const shown = vi.hoisted(() => [] as Array<{ title: string; body: string }>)
vi.mock('electron', () => ({
  Notification: class {
    constructor(private readonly options: { title: string; body: string }) {}
    on(): void {}
    show(): void { shown.push(this.options) }
  }
}))

function notifier(): DshNotifier {
  return new DshNotifier({
    getSettings: () => ({ approvals: true, turnComplete: true, errors: true, onlyWhenHidden: false }),
    isMainWindowVisible: () => false,
    isNotificationSupported: () => true,
    onFocusRequested: () => {}
  })
}

describe('durable turn wording', () => {
  beforeEach(() => { shown.length = 0 })

  it('calls only completed a completed task', () => {
    const observer = notifier()
    for (const reason of ['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'future-kind']) {
      observer.handleSignal({ kind: 'turn-ended', sessionId: `s-${reason}`, reason, errorMessage: reason === 'error' ? 'failed' : null })
    }
    expect(shown.map((item) => item.title)).toEqual([
      '任务完成', '本轮已中止', '任务受阻', '任务失败', '已达输出上限', '运行被中断', '本轮已结束'
    ])
  })

  it('surfaces observer degradation under the errors setting', () => {
    notifier().handleSignal({ kind: 'observer-error', sessionId: 'session-1' })
    expect(shown[0]?.title).toBe('通知监测受限')
  })
})
