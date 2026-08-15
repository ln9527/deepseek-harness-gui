import { describe, expect, it } from 'vitest'
import { parseWsFrame } from '../../src/main/notify-bridge/ws-frame-schemas'

function frame(payload: unknown, method = 'x'): string {
  return JSON.stringify({ type: 'server-request', rpcId: 'r1', method, payload })
}

describe('parseWsFrame(两级宽校验,fail-soft)', () => {
  it('approval/requested 正确 narrow(含可选 reason)', () => {
    const signal = parseWsFrame(
      frame({ type: 'approval/requested', sessionId: 's1', approvalId: 'a1', toolName: 'bash', reason: 'needs review' })
    )
    expect(signal).toEqual({
      kind: 'approval-requested',
      sessionId: 's1',
      approvalId: 'a1',
      toolName: 'bash',
      reason: 'needs review'
    })
  })

  it('approval/resolved', () => {
    const signal = parseWsFrame(frame({ type: 'approval/resolved', sessionId: 's1', approvalId: 'a1', outcome: 'allow' }))
    expect(signal).toEqual({ kind: 'approval-resolved', approvalId: 'a1' })
  })

  it('host/session-status / host/agent-error', () => {
    expect(parseWsFrame(frame({ type: 'host/session-status', sessionId: 's1', running: false }))).toEqual({
      kind: 'session-status',
      sessionId: 's1',
      running: false
    })
    expect(parseWsFrame(frame({ type: 'host/agent-error', sessionId: 's1', message: 'boom' }))).toEqual({
      kind: 'agent-error',
      sessionId: 's1',
      message: 'boom'
    })
  })

  it('未知 payload 类型 → ignored(第一级通过,第二级不认识)', () => {
    const signal = parseWsFrame(frame({ type: 'session/event', sessionId: 's1', event: { t: 'chunk' } }))
    expect(signal).toEqual({ kind: 'ignored', reason: 'unknown-payload' })
  })

  it('关心的类型但字段缺失 → ignored(malformed)', () => {
    expect(parseWsFrame(frame({ type: 'approval/requested', sessionId: 's1' }))).toEqual({
      kind: 'ignored',
      reason: 'malformed-payload'
    })
  })

  it('非 server-request 信封 / 非 JSON / payload 非对象 → ignored', () => {
    expect(parseWsFrame(JSON.stringify({ type: 'server-response', rpcId: 'r', result: {} }))).toEqual({
      kind: 'ignored',
      reason: 'not-server-request'
    })
    expect(parseWsFrame('not json at all')).toEqual({ kind: 'ignored', reason: 'not-json' })
    expect(parseWsFrame(frame('string-payload'))).toEqual({ kind: 'ignored', reason: 'unknown-payload' })
    expect(parseWsFrame(frame(null))).toEqual({ kind: 'ignored', reason: 'unknown-payload' })
  })

  it('多出来的未知字段不影响 narrow(前向兼容)', () => {
    const signal = parseWsFrame(
      frame({ type: 'host/session-status', sessionId: 's1', running: true, brandNewField: { x: 1 } })
    )
    expect(signal).toEqual({ kind: 'session-status', sessionId: 's1', running: true })
  })
})
