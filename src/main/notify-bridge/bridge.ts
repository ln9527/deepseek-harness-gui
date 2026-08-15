/**
 * WS 通知桥:两条 downlink 连接(events.mux + events.host)。
 * 只收不发(客户端发帧 = 服务端 close 1008,协议规定)。
 * 显式带同源 Origin 头过信任围栏;断线 1s 重连(仅在 attach 状态);
 * 任何错误只影响桥自身(supervisor 状态机的 bridgeConnected 展示)。
 */

import WebSocket, { type RawData } from 'ws'
import { getLogger } from '../logger'
import { parseWsFrame, type BridgeSignal, type IgnoredReason } from './ws-frame-schemas'

const log = getLogger('notify-bridge')

const MUX_PATH = '/api/events.mux'
const HOST_PATH = '/api/events.host'

type SignalListener = (signal: Exclude<BridgeSignal, { kind: 'ignored' }>) => void
type IgnoredListener = (reason: IgnoredReason) => void
type ConnectedListener = (connected: boolean) => void

/** ws 包的连接面(注入可测;注意 message 回调签名是 (data, isBinary),非浏览器 API)。 */
export interface BridgeSocket {
  on(event: 'open', listener: () => void): void
  on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): void
  on(event: 'close', listener: (code: number, reason: Buffer) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  close(): void
}

export interface BridgeOptions {
  readonly reconnectDelayMs?: number
  readonly socketFactory?: (url: string, origin: string) => BridgeSocket
}

interface Conn {
  readonly socket: BridgeSocket
  readonly stream: 'mux' | 'host'
  open: boolean
}

/** RawData(Buffer | ArrayBuffer | Buffer[])→ UTF-8 字符串。 */
export function rawDataToString(data: RawData): string {
  if (typeof data === 'string') {
    return data
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString('utf8')
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString('utf8')
  }
  return Buffer.isBuffer(data) ? data.toString('utf8') : String(data)
}

const defaultSocketFactory = (url: string, origin: string): BridgeSocket =>
  new WebSocket(url, { headers: { Origin: origin }, handshakeTimeout: 5000 }) as unknown as BridgeSocket

export class NotifyBridge {
  private conns: readonly Conn[] = []
  private attachedPort: number | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private readonly signalListeners = new Set<SignalListener>()
  private readonly ignoredListeners = new Set<IgnoredListener>()
  private readonly connectedListeners = new Set<ConnectedListener>()
  private ignoredCount = 0

  constructor(private readonly options: BridgeOptions = {}) {}

  attach(port: number): void {
    if (this.attachedPort === port) {
      return
    }
    this.detach()
    this.attachedPort = port
    log.info('bridge attaching', { port })
    this.connect(port)
  }

  detach(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.attachedPort = null
    for (const conn of this.conns) {
      try {
        conn.socket.close()
      } catch {
        // 已断开则忽略
      }
    }
    this.conns = []
    this.setConnectedState()
  }

  isConnected(): boolean {
    return this.conns.length > 0 && this.conns.every((c) => c.open)
  }

  getIgnoredCount(): number {
    return this.ignoredCount
  }

  onSignal(listener: SignalListener): () => void {
    this.signalListeners.add(listener)
    return () => {
      this.signalListeners.delete(listener)
    }
  }

  onIgnored(listener: IgnoredListener): () => void {
    this.ignoredListeners.add(listener)
    return () => {
      this.ignoredListeners.delete(listener)
    }
  }

  onConnectedChange(listener: ConnectedListener): () => void {
    this.connectedListeners.add(listener)
    return () => {
      this.connectedListeners.delete(listener)
    }
  }

  private connect(port: number): void {
    const factory = this.options.socketFactory ?? defaultSocketFactory
    const origin = `http://127.0.0.1:${port}`
    const mk = (stream: 'mux' | 'host', path: string): Conn => {
      const socket = factory(`ws://127.0.0.1:${port}${path}`, origin)
      const conn: Conn = { socket, stream, open: false }
      socket.on('open', () => {
        conn.open = true
        log.info('stream open', { stream })
        this.setConnectedState()
      })
      socket.on('message', (data) => {
        // fail-soft:任何单帧处理异常都不得冒泡成 uncaughtException
        try {
          this.handleRaw(stream, rawDataToString(data))
        } catch (error) {
          log.error('frame handler threw (ignored)', {
            stream,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      })
      socket.on('error', (error) => {
        log.debug('stream error', { stream, error: error.message })
      })
      socket.on('close', () => {
        conn.open = false
        this.setConnectedState()
        // 只对"当前代"连接触发重连:重连清理/detach 时主动关闭的旧连接不算断线
        if (this.conns.includes(conn)) {
          this.scheduleReconnect()
        }
      })
      return conn
    }
    this.conns = [mk('mux', MUX_PATH), mk('host', HOST_PATH)]
  }

  private handleRaw(stream: 'mux' | 'host', raw: string): void {
    const signal = parseWsFrame(raw)
    if (signal.kind === 'ignored') {
      this.ignoredCount += 1
      log.debug('frame ignored', { stream, reason: signal.reason })
      for (const listener of [...this.ignoredListeners]) {
        listener(signal.reason)
      }
      return
    }
    for (const listener of [...this.signalListeners]) {
      try {
        listener(signal)
      } catch (error) {
        log.error('signal listener threw', {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.attachedPort === null || this.reconnectTimer !== null) {
      return
    }
    const port = this.attachedPort
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.attachedPort === port) {
        log.info('bridge reconnecting', { port })
        // 先摘牌再关闭:旧连接的 close 不允许再次触发重连调度
        const stale = this.conns
        this.conns = []
        for (const conn of stale) {
          try {
            conn.socket.close()
          } catch {
            // 已断开则忽略
          }
        }
        this.connect(port)
      }
    }, this.options.reconnectDelayMs ?? 1000)
  }

  private setConnectedState(): void {
    const connected = this.isConnected()
    for (const listener of [...this.connectedListeners]) {
      listener(connected)
    }
  }
}
