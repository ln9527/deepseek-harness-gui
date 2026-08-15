import { describe, expect, it } from 'vitest'
import {
  emptyApprovalDedupe,
  emptyCompletionAggregate,
  observeApproval,
  observeCompletion,
  resolveApproval
} from '../../src/main/notify-bridge/dedupe'

describe('approval 去重(重连 replay 防护)', () => {
  it('同 approvalId 第二次判为重复', () => {
    const first = observeApproval(emptyApprovalDedupe, 'a1')
    expect(first.isDuplicate).toBe(false)
    const second = observeApproval(first.state, 'a1')
    expect(second.isDuplicate).toBe(true)
    expect(second.state).toBe(first.state)
  })

  it('approval/resolved 清除后,同 id 再现视为新事件', () => {
    const seen = observeApproval(emptyApprovalDedupe, 'a1').state
    const resolved = resolveApproval(seen, 'a1')
    expect(resolved.seen).toEqual([])
    const again = observeApproval(resolved, 'a1')
    expect(again.isDuplicate).toBe(false)
  })

  it('LRU 上限裁剪最旧条目', () => {
    let state = emptyApprovalDedupe
    for (let i = 0; i < 205; i++) {
      state = observeApproval(state, `id-${i}`).state
    }
    expect(state.seen.length).toBe(200)
    expect(state.seen[0]).toBe('id-5')
    expect(observeApproval(state, 'id-0').isDuplicate).toBe(false)
  })
})

describe('会话完成聚合窗口', () => {
  it('窗口外首发 → notify(count=1);窗口内 → absorb', () => {
    const t0 = 1_000_000
    const first = observeCompletion(emptyCompletionAggregate, 's1', t0)
    expect(first.decision).toEqual({ action: 'notify', count: 1 })
    const second = observeCompletion(first.state, 's1', t0 + 3000)
    expect(second.decision).toEqual({ action: 'absorb', count: 2 })
    expect(second.state.sessions['s1']?.count).toBe(2)
  })

  it('窗口过期后重新 notify 并重置计数', () => {
    const t0 = 1_000_000
    const first = observeCompletion(emptyCompletionAggregate, 's1', t0)
    const afterWindow = observeCompletion(first.state, 's1', t0 + 10_001)
    expect(afterWindow.decision).toEqual({ action: 'notify', count: 1 })
  })

  it('会话之间互不影响', () => {
    const t0 = 1_000_000
    const s1 = observeCompletion(emptyCompletionAggregate, 's1', t0)
    const s2 = observeCompletion(s1.state, 's2', t0 + 100)
    expect(s2.decision).toEqual({ action: 'notify', count: 1 })
    expect(s2.state.sessions['s1']?.count).toBe(1)
  })
})
