import { describe, expect, it } from 'vitest'
import { findSystemNode, resolveNodeExec, satisfiesNodeFloor } from '../../src/main/dsh-runtime/node-exec'

describe('satisfiesNodeFloor', () => {
  it('地板版本判定(node:sqlite >= 22.13)', () => {
    expect(satisfiesNodeFloor('v22.13.0')).toBe(true)
    expect(satisfiesNodeFloor('v22.12.9')).toBe(false)
    expect(satisfiesNodeFloor('22.19.0')).toBe(true)
    expect(satisfiesNodeFloor('v24.0.0')).toBe(true)
    expect(satisfiesNodeFloor('garbage')).toBe(false)
  })
})

describe('findSystemNode', () => {
  it('按 PATH 顺序探测并去重', () => {
    const exists = (p: string) => p === '/opt/homebrew/bin/node' || p === '/usr/local/bin/node'
    expect(findSystemNode('/a:/b', exists)).toBe('/opt/homebrew/bin/node')
    expect(findSystemNode('/x:/y', () => false)).toBeNull()
  })
})

describe('resolveNodeExec', () => {
  it('系统 node 满足地板时优先使用(ABI 匹配,无附加 flag)', () => {
    const r = resolveNodeExec({
      electronExecPath: '/Applications/DSH GUI.app/Contents/MacOS/DSH GUI',
      electronNodeVersion: '24.18.0',
      envPath: '',
      exists: (p) => p === '/opt/homebrew/bin/node'
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
