import { parseNotifyEvent, type BridgeSignal, type SessionRecord } from './session-schemas'

type Approval = { readonly toolName: string; readonly reason: string | null }
export interface JournalState {
  readonly cursor: number
  readonly pending: ReadonlyMap<string, Approval>
  readonly turnOpen: boolean
}

/** Initial scan only restores approvals still in the current open turn. */
export function initializeJournal(sessionId: string, cursor: number, records: readonly SessionRecord[], running: boolean, completedAfterMs?: number): {
  readonly state: JournalState
  readonly signals: readonly BridgeSignal[]
} {
  let boundary = -1
  for (let index = records.length - 1; index >= 0; index--) {
    if (records[index]?.type === 'turn/start' || records[index]?.type === 'turn/end') { boundary = index; break }
  }
  const open = running && boundary >= 0 && records[boundary]?.type === 'turn/start'
  const pending = new Map<string, Approval>()
  if (open) {
    for (const record of records.slice(boundary + 1)) {
      const event = parseNotifyEvent(record)
      if (event.kind === 'approval-asked') pending.set(event.id, { toolName: event.toolName, reason: event.reason })
      if (event.kind === 'approval-decided') pending.delete(event.id)
    }
  }
  const latestBoundary = records[boundary]
  const recentEnd = !running && latestBoundary?.type === 'turn/end' &&
    completedAfterMs !== undefined && latestBoundary.time > completedAfterMs
    ? parseNotifyEvent(latestBoundary)
    : null
  return {
    state: { cursor, pending, turnOpen: open },
    signals: [
      ...[...pending].map(([approvalId, approval]): BridgeSignal => ({
        kind: 'approval-requested', sessionId, approvalId, toolName: approval.toolName, reason: approval.reason
      })),
      ...(recentEnd?.kind === 'turn-ended' ? [{
        kind: 'turn-ended' as const, sessionId, reason: recentEnd.reason, errorMessage: recentEnd.errorMessage
      }] : [])
    ]
  }
}

/** Process a complete contiguous suffix, then notify only approvals still pending. */
export function advanceJournal(sessionId: string, previous: JournalState, cursor: number, records: readonly SessionRecord[], running: boolean): {
  readonly state: JournalState
  readonly signals: readonly BridgeSignal[]
} {
  if (cursor < previous.cursor) throw new Error('session cursor moved backwards')
  if (cursor === previous.cursor) {
    if (running || previous.pending.size === 0) return { state: previous, signals: [] }
    return {
      state: { ...previous, pending: new Map(), turnOpen: false },
      signals: [...previous.pending.keys()].map((approvalId) => ({ kind: 'approval-resolved', sessionId, approvalId }))
    }
  }
  let expected = previous.cursor + 1
  const pending = new Map(previous.pending)
  const endings: BridgeSignal[] = []
  let turnOpen = previous.turnOpen
  for (const record of records) {
    if (record.seq !== expected) throw new Error('session page has a gap or duplicate')
    expected++
    const event = parseNotifyEvent(record)
    if (event.kind === 'turn-started') {
      turnOpen = true
      pending.clear()
    } else if (event.kind === 'approval-asked') {
      if (turnOpen) pending.set(event.id, { toolName: event.toolName, reason: event.reason })
    } else if (event.kind === 'approval-decided') {
      pending.delete(event.id)
    } else if (event.kind === 'turn-ended') {
      turnOpen = false
      pending.clear()
      endings.push({ kind: 'turn-ended', sessionId, reason: event.reason, errorMessage: event.errorMessage })
    }
  }
  if (expected !== cursor + 1) throw new Error('session page did not reach requested cursor')
  if (!running) pending.clear()
  const signals: BridgeSignal[] = []
  for (const approvalId of previous.pending.keys()) {
    if (!pending.has(approvalId)) signals.push({ kind: 'approval-resolved', sessionId, approvalId })
  }
  for (const [approvalId, approval] of pending) {
    if (!previous.pending.has(approvalId)) signals.push({
      kind: 'approval-requested', sessionId, approvalId, toolName: approval.toolName, reason: approval.reason
    })
  }
  return { state: { cursor, pending, turnOpen }, signals: [...signals.filter((signal) => signal.kind === 'approval-resolved'), ...endings,
    ...signals.filter((signal) => signal.kind === 'approval-requested')] }
}
