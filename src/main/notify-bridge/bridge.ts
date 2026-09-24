/** Read-only durable Session polling for bundled DSH 0.1.5-rc.2. */
import { createHash, randomUUID } from 'node:crypto'
import { getLogger } from '../logger'
import { advanceJournal, initializeJournal, type JournalState } from './journal'
import { parseSessionList, parseSessionPage, type BridgeSignal, type SessionRecord } from './session-schemas'

const log = getLogger('notify-bridge')
const PAGE_MESSAGES = 50
const MAX_PAGES_PER_POLL = 200

type SignalListener = (signal: BridgeSignal) => void
type ConnectedListener = (connected: boolean) => void
export type ReadonlyRpc = (port: number, cookie: string, endpoint: 'session/list' | 'session/page', args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
export interface BridgeOptions {
  readonly cookieProvider: (port: number) => Promise<string | null>
  readonly rpc?: ReadonlyRpc
  readonly pollIntervalMs?: number
  readonly now?: () => number
}

/** BrowserAuth hashes the exact Host authority into its HttpOnly cookie name. */
export function sessionCookieName(port: number): string {
  return `dsh-auth-${createHash('sha256').update(`127.0.0.1:${port}`).digest('base64url')}`
}

/** Only the two explicitly allowed read endpoints can be called. */
export const readOnlySessionRpc: ReadonlyRpc = async (port, cookie, endpoint, args, signal) => {
  const rpcId = randomUUID()
  const response = await fetch(`http://127.0.0.1:${port}/api/${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'origin': `http://127.0.0.1:${port}`,
      'cookie': cookie
    },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(5000)])
  })
  if (!response.ok) throw new Error(`Session RPC HTTP ${response.status}`)
  const body: unknown = await response.json()
  if (typeof body !== 'object' || body === null || !('type' in body) || body.type !== 'server-response' ||
      !('rpcId' in body) || body.rpcId !== rpcId || !('result' in body) || typeof body.result !== 'object' || body.result === null) {
    throw new Error('invalid Session RPC response')
  }
  const result = body.result as { ok?: unknown; value?: unknown; error?: { code?: string } }
  if (result.ok !== true) throw new Error(`Session RPC failed: ${result.error?.code ?? 'unknown'}`)
  return result.value
}

export class NotifyBridge {
  private port: number | null = null
  private generation = 0
  private controller: AbortController | null = null
  private timer: NodeJS.Timeout | null = null
  private inFlight: Promise<void> | null = null
  private connected = false
  private attachedAtMs: number | null = null
  private readonly journals = new Map<string, JournalState>()
  private readonly degradedSessions = new Set<string>()
  private readonly signalListeners = new Set<SignalListener>()
  private readonly connectedListeners = new Set<ConnectedListener>()

  constructor(private readonly options: BridgeOptions) {}
  attach(port: number): void {
    if (this.port === port) return
    this.detach()
    this.port = port
    this.attachedAtMs = this.options.now?.() ?? Date.now()
    this.controller = new AbortController()
    this.schedule(0)
  }
  detach(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.generation++
    this.controller?.abort()
    this.controller = null
    this.port = null
    this.attachedAtMs = null
    this.inFlight = null
    this.journals.clear()
    this.degradedSessions.clear()
    this.setConnected(false)
  }
  isConnected(): boolean { return this.connected }
  onSignal(listener: SignalListener): () => void { this.signalListeners.add(listener); return () => { this.signalListeners.delete(listener) } }
  onConnectedChange(listener: ConnectedListener): () => void { this.connectedListeners.add(listener); return () => { this.connectedListeners.delete(listener) } }

  /** Exposed for deterministic tests and a manual refresh; scheduled polls use the same path. */
  pollNow(): Promise<void> {
    if (this.port === null || this.controller === null) return Promise.resolve()
    if (this.inFlight) return this.inFlight
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const port = this.port
    const generation = this.generation
    const signal = this.controller.signal
    const work = this.poll(port, generation, signal).catch((error: unknown) => {
      if (!this.isCurrent(port, generation)) return
      this.setConnected(false)
      log.warn('read-only Session poll failed', { error: error instanceof Error ? error.message : String(error) })
    }).finally(() => {
      if (this.inFlight === work) this.inFlight = null
      if (this.isCurrent(port, generation)) this.schedule(this.options.pollIntervalMs ?? 2000)
    })
    this.inFlight = work
    return work
  }
  private async poll(port: number, generation: number, signal: AbortSignal): Promise<void> {
    const cookie = await this.options.cookieProvider(port)
    if (!this.isCurrent(port, generation)) return
    if (cookie === null) { this.setConnected(false); return }
    const rpc = this.options.rpc ?? readOnlySessionRpc
    const summaries = parseSessionList(await rpc(port, cookie, 'session/list', { _request: {} }, signal))
    if (!this.isCurrent(port, generation)) return
    let healthy = true
    for (const summary of summaries) {
      if (!this.isCurrent(port, generation)) return
      // Subagent history needs a parent address and mode; omit it until that contract is available.
      if (summary.origin === 'subagent') continue
      const previous = this.journals.get(summary.sessionId)
      const cursor = summary.projections?.asOfSeq
      if (cursor === undefined) {
        if (previous && !summary.running && previous.pending.size > 0) {
          const result = advanceJournal(summary.sessionId, previous, previous.cursor, [], false)
          this.journals.set(summary.sessionId, result.state)
          for (const notification of result.signals) this.emit(notification)
        }
        continue
      }
      if (previous?.cursor === cursor) {
        if (!summary.running && previous.pending.size > 0) {
          const result = advanceJournal(summary.sessionId, previous, cursor, [], false)
          this.journals.set(summary.sessionId, result.state)
          for (const notification of result.signals) this.emit(notification)
        }
        continue
      }
      if (previous && cursor < previous.cursor) { this.journals.delete(summary.sessionId); continue }
      try {
        // A new or newly prompted Session can finish between two list polls.
        // Inspect its last turn only when list metadata proves activity after attach;
        // the event timestamp below prevents replaying older completed turns.
        const recentFinished = previous === undefined && !summary.running &&
          this.attachedAtMs !== null && summary.updatedAt > this.attachedAtMs
        const records = cursor < 0 || (previous === undefined && !summary.running && !recentFinished)
          ? []
          : await this.readPages(rpc, port, cookie, summary.sessionId, cursor, previous?.cursor, signal)
        if (!this.isCurrent(port, generation)) return
        const result = previous === undefined
          ? initializeJournal(summary.sessionId, cursor, records, summary.running, recentFinished ? this.attachedAtMs! : undefined)
          : advanceJournal(summary.sessionId, previous, cursor, records, summary.running)
        this.journals.set(summary.sessionId, result.state)
        this.degradedSessions.delete(summary.sessionId)
        for (const notification of result.signals) this.emit(notification)
      } catch (error) {
        if (signal.aborted) return
        healthy = false
        log.warn('Session journal unavailable', { sessionId: summary.sessionId, error: error instanceof Error ? error.message : String(error) })
        if (!this.degradedSessions.has(summary.sessionId)) {
          this.degradedSessions.add(summary.sessionId)
          this.emit({ kind: 'observer-error', sessionId: summary.sessionId })
        }
      }
    }
    if (this.isCurrent(port, generation)) this.setConnected(healthy)
  }
  private async readPages(rpc: ReadonlyRpc, port: number, cookie: string, sessionId: string, cursor: number, previousCursor: number | undefined, signal: AbortSignal): Promise<SessionRecord[]> {
    const pages: SessionRecord[][] = []
    let beforeSeq: number | undefined
    for (let count = 0; count < MAX_PAGES_PER_POLL; count++) {
      const request = { address: { kind: 'session', sessionId }, throughSeq: cursor, maxMessages: PAGE_MESSAGES,
        ...(beforeSeq === undefined ? {} : { beforeSeq }) }
      const page = parseSessionPage(await rpc(port, cookie, 'session/page', { request }, signal))
      const records = page.records.map((entry) => entry.event)
      if (records.length === 0) {
        if (page.hasMore) throw new Error('empty Session page with more history')
        break
      }
      for (let index = 1; index < records.length; index++) {
        if (records[index]!.seq !== records[index - 1]!.seq + 1) throw new Error('Session page is not contiguous')
      }
      if (beforeSeq !== undefined && records.at(-1)!.seq !== beforeSeq - 1) throw new Error('Session pages have a gap')
      pages.push(records)
      const first = records[0]!.seq
      if (previousCursor !== undefined && first <= previousCursor + 1) break
      if (previousCursor === undefined && records.some((record) => record.type === 'turn/start' || record.type === 'turn/end')) break
      if (!page.hasMore) break
      if (first === 0) throw new Error('Session page reports history before seq 0')
      beforeSeq = first
      if (count === MAX_PAGES_PER_POLL - 1) throw new Error('Session history exceeds polling page budget')
    }
    const all = pages.reverse().flat()
    const suffix = previousCursor === undefined ? all : all.filter((record) => record.seq > previousCursor)
    if (previousCursor !== undefined && suffix[0]?.seq !== previousCursor + 1) throw new Error('Session history prefix unavailable')
    if (suffix.at(-1)?.seq !== cursor) throw new Error('Session history did not reach requested cursor')
    return suffix
  }
  private isCurrent(port: number, generation: number): boolean { return this.port === port && this.generation === generation }
  private schedule(ms: number): void {
    if (this.port === null || this.timer !== null) return
    this.timer = setTimeout(() => { this.timer = null; void this.pollNow() }, ms)
  }
  private emit(signal: BridgeSignal): void {
    for (const listener of [...this.signalListeners]) {
      try { listener(signal) } catch (error) { log.error('notification signal listener failed', { error: String(error) }) }
    }
  }
  private setConnected(value: boolean): void {
    if (this.connected === value) return
    this.connected = value
    for (const listener of [...this.connectedListeners]) listener(value)
  }
}
