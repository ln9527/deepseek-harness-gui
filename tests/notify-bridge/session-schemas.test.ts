import { describe, expect, it } from 'vitest'
import { parseNotifyEvent, parseSessionList, parseSessionPage } from '../../src/main/notify-bridge/session-schemas'

const event = (type: string, data: unknown) => ({ type, seq: 1, time: 100, data })

describe('bundled DSH 0.1.5-rc.2 durable Session contract', () => {
  it('accepts list and page wire shapes', () => {
    expect(parseSessionList({ items: [{ sessionId: 's1', updatedAt: 1000, running: true, projections: { asOfSeq: 3, values: {} } }] })[0]?.projections?.asOfSeq).toBe(3)
    expect(parseSessionPage({ records: [{ type: 'event', event: event('turn/start', { turn: 1 }) }], hasMore: false }).records).toHaveLength(1)
  })
  it('uses durable approval IDs and the turn end reason', () => {
    expect(parseNotifyEvent(event('approval/asked', { id: 'a1', toolName: 'bash', reason: 'review' }))).toEqual({ kind: 'approval-asked', id: 'a1', toolName: 'bash', reason: 'review' })
    expect(parseNotifyEvent(event('approval/decided', { id: 'a1', outcome: 'rejected' }))).toEqual({ kind: 'approval-decided', id: 'a1' })
    expect(parseNotifyEvent(event('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } } }))).toEqual({ kind: 'turn-ended', reason: 'error', errorMessage: 'boom' })
  })
  it('rejects malformed relevant data rather than advancing past an approval', () => {
    expect(() => parseNotifyEvent(event('approval/asked', { toolName: 'bash' }))).toThrow()
    expect(() => parseSessionPage({ records: [{ type: 'event', event: { type: 'x', seq: '1', time: 1, data: {} } }], hasMore: false })).toThrow()
  })
})
