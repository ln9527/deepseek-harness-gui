import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  defaultNodeLookupSpec,
  findSystemNode,
  readBundledNode,
  resolveNodeExec,
  satisfiesNodeFloor
} from '../../src/main/dsh-runtime/node-exec'

describe('satisfiesNodeFloor', () => {
  it('地板版本判定(DSH engines ^22.19||>=24;zstd API 22.15 才有)', () => {
    expect(satisfiesNodeFloor('v22.19.0')).toBe(true)
    expect(satisfiesNodeFloor('v22.12.9')).toBe(false)
    // 回归:真机 Windows 系统装了 22.14,旧地板(22.13)放过它,
    // DSH session-persistence-jsonl import createZstdDecompress → 启动即崩
    expect(satisfiesNodeFloor('v22.14.0')).toBe(false)
    expect(satisfiesNodeFloor('v22.15.0')).toBe(false) // 有 zstd 但低于 engines 线
    // 23.x 不在 engines 内(非 LTS;zstd 23.8 才有)
    expect(satisfiesNodeFloor('v23.9.0')).toBe(false)
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
    // join 的分隔符随宿主平台,统一归一化后比较
    const norm = (p: string): string => p.replace(/\\/g, '/')
    expect(findSystemNode('C:\\x;D:\\y', () => false, winSpec)).toBeNull()
    expect(
      norm(findSystemNode('C:\\x;D:\\y', (p) => norm(p) === 'D:/y/node.exe', winSpec) ?? '')
    ).toBe('D:/y/node.exe')
    expect(
      norm(
        findSystemNode('', (p) => norm(p) === 'C:/Program Files/nodejs/node.exe', winSpec) ?? ''
      )
    ).toBe('C:/Program Files/nodejs/node.exe')
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

  it('回归(真机 win 报案):系统 node 22.14 缺 zstd → 必须拒绝并回落 Electron 内嵌', () => {
    const r = resolveNodeExec({
      electronExecPath: '/fake/electron',
      electronNodeVersion: '24.18.0',
      envPath: '/x',
      exists: () => true,
      nodeVersion: () => 'v22.14.0'
    })
    expect(r.source).toBe('electron')
    expect(r.useRunAsNode).toBe(true)
    expect(r.nodeFlags).toEqual(['--expose-internals'])
    expect(r.reason).toContain('22.14')
  })

  it('系统 node 恰在 engines 下限(22.19)时仍优先系统 node', () => {
    const r = resolveNodeExec({
      electronExecPath: '/fake/electron',
      electronNodeVersion: '24.18.0',
      envPath: '/x',
      exists: () => true,
      nodeVersion: () => 'v22.19.1'
    })
    expect(r.source).toBe('system')
    expect(r.nodeFlags).toEqual([])
  })

  it('系统 node 过旧且内嵌过旧时抛错', () => {
    expect(() =>
      resolveNodeExec({
        electronExecPath: '/fake/electron',
        electronNodeVersion: '20.1.0',
        envPath: '',
        exists: () => false
      })
    ).toThrow(/运行时/)
  })
})

describe('resolveNodeExec: 内置 node.exe(win32 目录选择崩溃回归)', () => {
  it('内置 node 在位时最优先(压过满足地板的系统 node)', () => {
    const r = resolveNodeExec({
      electronExecPath: '/fake/electron',
      electronNodeVersion: '24.18.1',
      envPath: '/x',
      bundledNode: { exec: 'C:\\r\\node-runtime-win\\node.exe', version: '22.22.2' },
      exists: () => true,
      nodeVersion: () => 'v22.22.2'
    })
    expect(r.source).toBe('bundled')
    expect(r.useRunAsNode).toBe(false)
    expect(r.nodeFlags).toEqual([])
    expect(r.reason).toContain('22.22.2')
  })

  it('回归(真机 win 报案):无系统 node 时必须走内置 node,而不是 Electron 内嵌 Node', () => {
    // Electron 43 内嵌 Node 24.18.1 下 koffi.view 原生崩溃 →
    // win32 目录选择 worker 静默死亡(worker exited before reporting a result)
    const r = resolveNodeExec({
      electronExecPath: '/fake/electron',
      electronNodeVersion: '24.18.1',
      envPath: '',
      bundledNode: { exec: '/r/node-runtime-win/node.exe', version: '22.22.2' },
      exists: () => false
    })
    expect(r.source).toBe('bundled')
    expect(r.exec).toContain('node.exe')
  })

  it('内置 node 版本异常(低于地板)时不采用,照常回落', () => {
    const r = resolveNodeExec({
      electronExecPath: '/fake/electron',
      electronNodeVersion: '24.18.1',
      envPath: '',
      bundledNode: { exec: '/r/node.exe', version: '22.14.0' },
      exists: () => false
    })
    expect(r.source).toBe('electron')
  })
})

describe('readBundledNode', () => {
  it('win32:manifest + node.exe 在位返回 spec;损坏/缺失返回 null;darwin 恒 null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-bundled-node-'))
    try {
      writeFileSync(join(dir, 'node.exe'), 'fake-binary')
      // 真机上 node.exe 天然带可执行位;mac/linux 下 X_OK 探测要求显式 chmod
      chmodSync(join(dir, 'node.exe'), 0o755)
      writeFileSync(
        join(dir, '.node-runtime.json'),
        JSON.stringify({ version: '22.22.2', installedAt: 1 })
      )
      const spec = readBundledNode(dir, 'win32')
      expect(spec?.version).toBe('22.22.2')
      expect(spec?.exec.endsWith('node.exe')).toBe(true)

      // manifest 损坏 → 视为不存在(不抛错)
      writeFileSync(join(dir, '.node-runtime.json'), '{broken')
      expect(readBundledNode(dir, 'win32')).toBeNull()

      // manifest 合法但 node.exe 缺失 → 视为不存在
      writeFileSync(
        join(dir, '.node-runtime.json'),
        JSON.stringify({ version: '22.22.2', installedAt: 1 })
      )
      rmSync(join(dir, 'node.exe'))
      expect(readBundledNode(dir, 'win32')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    // darwin 无内置 node.exe 目录概念,恒 null
    expect(readBundledNode('/nonexistent', 'darwin')).toBeNull()
  })
})
