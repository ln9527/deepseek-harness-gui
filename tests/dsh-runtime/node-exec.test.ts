import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  defaultNodeLookupSpec,
  findSystemNode,
  resolveNodeExec,
  satisfiesNodeFloor
} from '../../src/main/dsh-runtime/node-exec'

describe('satisfiesNodeFloor', () => {
  it('地板版本判定(node:sqlite >= 22.13)', () => {
    expect(satisfiesNodeFloor('v22.13.0')).toBe(true)
    expect(satisfiesNodeFloor('v22.12.9')).toBe(false)
    expect(satisfiesNodeFloor('22.19.0')).toBe(true)
    expect(satisfiesNodeFloor('v24.0.0')).toBe(true)
    expect(satisfiesNodeFloor('garbage')).toBe(false)
  })
})

describe('findSystemNode(spec 注入,平台无关)', () => {
  const darwinSpec = defaultNodeLookupSpec('darwin')
  const winSpec = defaultNodeLookupSpec('win32')

  it('darwin:按 PATH 顺序探测并去重', () => {
    const exists = (p: string) => p === '/opt/homebrew/bin/node' || p === '/usr/local/bin/node'
    expect(findSystemNode('/a:/b', exists, darwinSpec)).toBe('/opt/homebrew/bin/node')
    expect(findSystemNode('/x:/y', () => false, darwinSpec)).toBeNull()
  })

  it('win32:分号分隔 + node.exe + Program Files 兜底', () => {
    expect(findSystemNode('C:\\x;D:\\y', () => false, winSpec)).toBeNull()
    expect(
      findSystemNode('C:\\x;D:\\y', (p) => p === 'D:\\y\\node.exe', winSpec)
    ).toBe('D:\\y\\node.exe')
    expect(
      findSystemNode('', (p) => p === 'C:\\Program Files\\nodejs\\node.exe', winSpec)
    ).toBe('C:\\Program Files\\nodejs\\node.exe')
  })
})

describe('resolveNodeExec', () => {
  it('系统 node 满足地板时优先使用(ABI 匹配,无附加 flag)——用当前运行中的真实 node 定位,任何机器成立', () => {
    const nodeDir = dirname(process.execPath)
    const r = resolveNodeExec({
      electronExecPath: '/fake/electron',
      electronNodeVersion: '24.18.0',
      envPath: nodeDir,
      exists: (p) => p === join(nodeDir, 'node') || p === join(nodeDir, 'node.exe')
    })
    expect(r.source).toBe('system')
    expect(r.useRunAsNode).toBe(false)
    expect(r.nodeFlags).toEqual([])
  })

  it('无系统 node 时用 Electron 内嵌 Node 并附加 --expose-internals', () => {
    const r = resolveNodeExec({
      electronExecPath: '/fake/electron',
      electronNodeVersion: '24.18.0',
      envPath: '',
      exists: () => false
    })
    expect(r.source).toBe('electron')
    expect(r.useRunAsNode).toBe(true)
    expect(r.nodeFlags).toEqual(['--expose-internals'])
  })

  it('系统 node 过旧且内嵌过旧时抛错', () => {
    expect(() =>
      resolveNodeExec({
        electronExecPath: '/fake/electron',
        electronNodeVersion: '20.1.0',
        envPath: '',
        exists: () => false
      })
    ).toThrow(/Node/)
  })
})
