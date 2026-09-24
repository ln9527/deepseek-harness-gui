import { describe, expect, it, vi } from 'vitest'
import { NotifyBridge, readOnlySessionRpc, sessionCookieName, type ReadonlyRpc } from '../../src/main/notify-bridge/bridge'
import type { BridgeSignal } from '../../src/main/notify-bridge/session-schemas'

type RecordValue = { type: string; seq: number; time: number; data: unknown }
const record = (seq: number, type: string, data: unknown): RecordValue => ({ seq, type, time: 100 + seq, data })

function fakeRuntime(records: RecordValue[], running = true) {
  const calls: string[] = []
  const rpc: ReadonlyRpc = async (_port, cookie, endpoint, args) => {
    expect(cookie).toBe('auth=cookie')
    calls.push(endpoint)
    if (endpoint === 'session/list') return { items: [{ sessionId: 's1', running, projections: { asOfSeq: records.at(-1)?.seq ?? -1, values: {} } }] }
    const request = args.request as { throughSeq: number; beforeSeq?: number }
    const end = Math.min(request.throughSeq + 1, request.beforeSeq ?? request.throughSeq + 1)
    const start = Math.max(0, end - 2)
    return { records: records.slice(start, end).map((event) => ({ type: 'event', event })), hasMore: start > 0 }
  }
  return { rpc, calls, setRunning: (value: boolean) => { running = value } }
}

describe('read-only notification polling', () => {
  it('waits for the browser cookie, restores only current pending approval, then reads completion', async () => {
    const records = [
      record(0, 'turn/start', { turn: 1 }),
      record(1, 'approval/asked', { id: 'a1', toolName: 'bash' })
    ]
    const runtime = fakeRuntime(records)
    let cookie: string | null = null
    const bridge = new NotifyBridge({ cookieProvider: async () => cookie, rpc: runtime.rpc, pollIntervalMs: 60_000 })
    const signals: BridgeSignal[] = []
    bridge.onSignal((signal) => { signals.push(signal) })
    bridge.attach(4321)
    await bridge.pollNow()
    expect(runtime.calls).toEqual([])
    expect(bridge.isConnected()).toBe(false)
    cookie = 'auth=cookie'
    await bridge.pollNow()
    expect(signals).toEqual([{ kind: 'approval-requested', sessionId: 's1', approvalId: 'a1', toolName: 'bash', reason: null }])
    records.push(record(2, 'approval/decided', { id: 'a1', outcome: 'allowed-once' }))
    records.push(record(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }))
    runtime.setRunning(false)
    await bridge.pollNow()
    expect(signals.slice(1)).toEqual([
      { kind: 'approval-resolved', sessionId: 's1', approvalId: 'a1' },
      { kind: 'turn-ended', sessionId: 's1', reason: 'completed', errorMessage: null }
    ])
    expect(new Set(runtime.calls)).toEqual(new Set(['session/list', 'session/page']))
    bridge.detach()
    bridge.attach(4321)
    await bridge.pollNow()
    expect(signals).toHaveLength(3) // old completed turn is not replayed on startup
    bridge.detach()
  })

  it('pages back through the open turn and suppresses approvals decided in the same poll', async () => {
    const records = [
      record(0, 'turn/end', { turn: 0, reason: { kind: 'completed' } }),
      record(1, 'turn/start', { turn: 1 }),
      record(2, 'approval/asked', { id: 'a1', toolName: 'tool' }),
      record(3, 'tool/call', {}),
      record(4, 'tool/result', {}),
      record(5, 'tool/call', {})
    ]
    const runtime = fakeRuntime(records)
    const bridge = new NotifyBridge({ cookieProvider: async () => 'auth=cookie', rpc: runtime.rpc, pollIntervalMs: 60_000 })
    const signals: BridgeSignal[] = []
    bridge.onSignal((signal) => { signals.push(signal) })
    bridge.attach(4321)
    await bridge.pollNow()
    expect(signals).toEqual([{ kind: 'approval-requested', sessionId: 's1', approvalId: 'a1', toolName: 'tool', reason: null }])
    expect(runtime.calls.filter((call) => call === 'session/page')).toHaveLength(3)
    records.push(record(6, 'approval/decided', { id: 'a1', outcome: 'rejected' }))
    records.push(record(7, 'approval/asked', { id: 'a2', toolName: 'brief' }))
    records.push(record(8, 'approval/decided', { id: 'a2', outcome: 'rejected' }))
    await bridge.pollNow()
    expect(signals.slice(1)).toEqual([{ kind: 'approval-resolved', sessionId: 's1', approvalId: 'a1' }])
    bridge.detach()
  })

  it('clears a pending reminder when the session stops without a new readable event', async () => {
    const records = [record(0, 'turn/start', { turn: 1 }), record(1, 'approval/asked', { id: 'a1', toolName: 'bash' })]
    const runtime = fakeRuntime(records)
    const bridge = new NotifyBridge({ cookieProvider: async () => 'auth=cookie', rpc: runtime.rpc, pollIntervalMs: 60_000 })
    const signals: BridgeSignal[] = []
    bridge.onSignal((signal) => { signals.push(signal) })
    bridge.attach(4321)
    await bridge.pollNow()
    runtime.setRunning(false)
    await bridge.pollNow()
    expect(signals.at(-1)).toEqual({ kind: 'approval-resolved', sessionId: 's1', approvalId: 'a1' })
    bridge.detach()
  })

  it('does not let an old generation emit after port replacement', async () => {
    let release: ((value: unknown) => void) | undefined
    const deferred = new Promise<unknown>((resolve) => { release = resolve })
    const rpc: ReadonlyRpc = async (port) => port === 4321 ? deferred : { items: [] }
    const bridge = new NotifyBridge({ cookieProvider: async () => 'auth=cookie', rpc, pollIntervalMs: 60_000 })
    bridge.attach(4321)
    const oldPoll = bridge.pollNow()
    bridge.attach(4322)
    await bridge.pollNow()
    release?.({ items: [{ sessionId: 'stale', running: false, projections: { asOfSeq: -1 } }] })
    await oldPoll
    expect(bridge.isConnected()).toBe(true)
    bridge.detach()
  })

  it('marks the bridge unhealthy when the initial turn exceeds the page budget', async () => {
    const records = [record(0, 'turn/start', { turn: 1 }),
      ...Array.from({ length: 499 }, (_, index) => record(index + 1, 'tool/call', {}))]
    const runtime = fakeRuntime(records)
    const bridge = new NotifyBridge({ cookieProvider: async () => 'auth=cookie', rpc: runtime.rpc, pollIntervalMs: 60_000 })
    const signals: BridgeSignal[] = []
    bridge.onSignal((signal) => { signals.push(signal) })
    bridge.attach(4321)
    await bridge.pollNow()
    expect(bridge.isConnected()).toBe(false)
    expect(signals).toEqual([{ kind: 'observer-error', sessionId: 's1' }])
    expect(runtime.calls.filter((call) => call === 'session/page')).toHaveLength(200)
    bridge.detach()
  })
})

describe('bundled RPC envelope', () => {
  it('sends only a cookie-bound read call to /api/session/list', async () => {
    const original = globalThis.fetch
    const send = vi.fn(async (_url: unknown, options: RequestInit) => {
      const message = JSON.parse(options.body as string) as { rpcId: string; method: string; payload: unknown }
      expect(message.method).toBe('session/list')
      expect(message.payload).toEqual({ args: { _request: {} } })
      expect(options.headers).toMatchObject({ cookie: 'dsh-auth-x=value', origin: 'http://127.0.0.1:4321' })
      return { ok: true, json: async () => ({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value: { items: [] } } }) } as Response
    })
    globalThis.fetch = send as typeof fetch
    try {
      expect(await readOnlySessionRpc(4321, 'dsh-auth-x=value', 'session/list', { _request: {} }, new AbortController().signal)).toEqual({ items: [] })
      expect(send.mock.calls[0]?.[0]).toBe('http://127.0.0.1:4321/api/session/list')
      expect(sessionCookieName(4321)).toMatch(/^dsh-auth-[A-Za-z0-9_-]+$/)
    } finally { globalThis.fetch = original }
  })
})
