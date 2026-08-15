/**
 * 去重与聚合(纯函数,状态由调用方持有):
 * - approvalId LRU 去重:mux 流重连会 replay 仍 pending 的审批帧(rpcId/approvalId
 *   原样复用),重复帧不得重复通知;approval/resolved 到达即清除。
 * - 会话完成聚合:同一 session 在窗口期内的后续完成静默吸收(首个已通知)。
 */

export const APPROVAL_DEDUPE_CAP = 200
export const COMPLETION_WINDOW_MS = 10_000

export interface ApprovalDedupeState {
  readonly seen: readonly string[]
}

export const emptyApprovalDedupe: ApprovalDedupeState = { seen: [] }

export function observeApproval(
  state: ApprovalDedupeState,
  approvalId: string,
  cap = APPROVAL_DEDUPE_CAP
): { readonly state: ApprovalDedupeState; readonly isDuplicate: boolean } {
  if (state.seen.includes(approvalId)) {
    return { state, isDuplicate: true }
  }
  const next = [...state.seen, approvalId]
  const trimmed = next.length > cap ? next.slice(next.length - cap) : next
  return { state: { seen: trimmed }, isDuplicate: false }
}

export function resolveApproval(state: ApprovalDedupeState, approvalId: string): ApprovalDedupeState {
  return { seen: state.seen.filter((id) => id !== approvalId) }
}

export interface SessionWindow {
  readonly count: number
  readonly windowStartAt: number
}

export interface CompletionAggregateState {
  readonly sessions: Readonly<Record<string, SessionWindow>>
}

export const emptyCompletionAggregate: CompletionAggregateState = { sessions: {} }

export type CompletionDecision =
  | { readonly action: 'notify'; readonly count: number }
  | { readonly action: 'absorb'; readonly count: number }

export function observeCompletion(
  state: CompletionAggregateState,
  sessionId: string,
  nowMs: number,
  windowMs = COMPLETION_WINDOW_MS
): { readonly state: CompletionAggregateState; readonly decision: CompletionDecision } {
  const existing = state.sessions[sessionId]
  const withinWindow =
    existing !== undefined && nowMs - existing.windowStartAt <= windowMs
  if (existing === undefined || !withinWindow) {
    const window: SessionWindow = { count: 1, windowStartAt: nowMs }
    return {
      state: { sessions: { ...state.sessions, [sessionId]: window } },
      decision: { action: 'notify', count: 1 }
    }
  }
  const window: SessionWindow = { count: existing.count + 1, windowStartAt: existing.windowStartAt }
  return {
    state: { sessions: { ...state.sessions, [sessionId]: window } },
    decision: { action: 'absorb', count: window.count }
  }
}
