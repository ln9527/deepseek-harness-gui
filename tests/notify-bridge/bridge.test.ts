/**
 * NotifyBridge 回归测试(修过的线上 bug:把 ws 的 message 回调当浏览器 API 用,
 * 访问 event.data → undefined.toString() 崩掉主进程)。
 * 用 ws 真实签名 (data: RawData, isBinary) 驱动 fake socket。
 */

import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import type { RawData } from 'ws'
import { NotifyBridge, rawDataToString, type BridgeSocket } from '../../src/main/notify-bridge/bridge'
import type { BridgeSignal } from '../../src/main/notify-bridge/ws-frame-schemas'

class FakeSocket implements BridgeSocket {
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  closed = false

  constructor(readonly url: string) {}

  on(event: 'open', listener: () => void): void
  on(event: 'message', listener: (data: RawData, isBinary: boolean) => void): void
  on(event: 'close', listener: (code: number, reason: Buffer) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  on(event: string, listener: (...args: never[]) => void): void {
    const list = this.listeners.get(event) ?? []
    list.push(listener as (...args: unknown[]) => void)
    this.listeners.set(event, list)
  }

  close(): void {
    if (!this.closed) {
      this.closed = true
      this.emit('close', 1006, Buffer.alloc(0))
    }
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener(...args)
    }
  }

  /** 按 ws 的真实签名触发 message:data 在第一位,没有 event 对象。 */
  emitMessage(data: RawData): void {
    this.emit('message', data, false)
  }
}

function makeBridge(): { bridge: NotifyBridge; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = []
  const bridge = new NotifyBridge({
    reconnectDelayMs: 5,
    socketFactory: (url) => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    }
  })
  return { bridge, sockets }
}

const approvalFrame = JSON.stringify({
  type: 'server-request',
  rpcId: 'r1',
  method: 'approval/requested',
  payload: { type: 'approval/requested', sessionId: 's1', approvalId: 'a1', toolName: 'bash' }
})

describe('rawDataToString', () => {
  it('覆盖 ws 的全部 RawData 形态(防御性含 string)', () => {
    expect(rawDataToString(Buffer.from(approvalFrame))).toBe(approvalFrame)
    expect(rawDataToString(new TextEncoder().encode(approvalFrame).buffer as ArrayBuffer)).toBe(approvalFrame)
    const chunk = Buffer.from(approvalFrame)
    const mid = Math.floor(chunk.length / 2)
    expect(rawDataToString([chunk.subarray(0, mid), chunk.subarray(mid)])).toBe(approvalFrame)
    expect(rawDataToString(approvalFrame as unknown as RawData)).toBe(approvalFrame)
  })
})

describe('NotifyBridge(fake socket,ws 签名)', () => {
  it('Buffer 帧正确解析为信号;Buffer[]/ArrayBuffer 形态不崩', () => {
    const { bridge, sockets } = makeBridge()
    const signals: Exclude<BridgeSignal, { kind: 'ignored' }>[] = []
    bridge.onSignal((s) => {
      signals.push(s)
    })
    bridge.attach(4321)
    expect(sockets.length).toBe(2)
    expect(sockets[0]?.url).toContain('/api/events.mux')
    expect(sockets[1]?.url).toContain('/api/events.host')
    for (const socket of sockets) {
      socket.emit('open')
    }
    expect(bridge.isConnected()).toBe(true)

    sockets[0]?.emitMessage(Buffer.from(approvalFrame))
    sockets[1]?.emitMessage([Buffer.from(approvalFrame)])
    const encoded = new TextEncoder().encode(approvalFrame).buffer as ArrayBuffer
    sockets[1]?.emitMessage(encoded)
    expect(signals.length).toBe(3)
    expect(signals[0]?.kind).toBe('approval-requested')

    bridge.detach()
  })

  it('垃圾帧被计入 ignored,不抛异常', () => {
    const { bridge, sockets } = makeBridge()
    bridge.attach(4321)
    sockets[0]?.emit('open')
    expect(() => sockets[0]?.emitMessage(Buffer.from('<html>not ws frame</html>'))).not.toThrow()
    expect(bridge.getIgnoredCount()).toBe(1)
    bridge.detach()
  })

  it('断线后按重连间隔重建连接', async () => {
    const { bridge, sockets } = makeBridge()
    const connected: boolean[] = []
    bridge.onConnectedChange((c) => {
      connected.push(c)
    })
    bridge.attach(4321)
    for (const socket of sockets) {
      socket.emit('open')
    }
    sockets[0]?.emit('close', 1000, Buffer.alloc(0))
    await new Promise((resolve) => {
      setTimeout(resolve, 40)
    })
    expect(sockets.length).toBe(4) // 首轮 2 + 重连 2
    bridge.detach()
  })

  it('detach 后不再重连', async () => {
    const { bridge, sockets } = makeBridge()
    bridge.attach(4321)
    sockets[0]?.emit('open')
    bridge.detach()
    sockets[0]?.emit('close', 1000, Buffer.alloc(0))
    await new Promise((resolve) => {
      setTimeout(resolve, 30)
    })
    expect(sockets.length).toBe(2)
  })
})
