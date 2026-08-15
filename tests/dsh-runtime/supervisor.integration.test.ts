/**
 * supervisor 真子进程集成测试:跑 fixtures/fake-dsh-server.mjs(本地、零网络)。
 * 退避基线缩短到 10ms,整轮耗尽 < 2s。
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { realChildProcessFactory } from '../../src/main/dsh-runtime/child-process'
import { DshRuntimeSupervisor } from '../../src/main/dsh-runtime/supervisor'
import type { DshRuntimeSnapshot } from '../../src/shared/contracts'
import { err, ok } from '../../src/main/util/result'

const fixturePath = join(import.meta.dirname, '../../fixtures/fake-dsh-server.mjs')

const supervisors: DshRuntimeSupervisor[] = []

afterAll(() => {
  for (const s of supervisors) {
    s.dispose()
  }
})

function makeSupervisor(
  mode: string,
  callbacks: { onReady?: (port: number) => void; onCrashed?: () => void; autoRestart?: boolean } = {}
): DshRuntimeSupervisor {
  const supervisor = new DshRuntimeSupervisor(
    {
      childFactory: realChildProcessFactory,
      spawnContractProvider: () => ({
        nodeExec: process.execPath,
        entryPath: fixturePath,
        args: [fixturePath],
        env: { ...process.env, DSH_FAKE_MODE: mode },
        cwd: tmpdir()
      }),
      getAutoRestart: () => callbacks.autoRestart ?? true,
      backoffBaseMs: 10,
      watchdogMs: 3000,
      stabilizeMs: 60_000,
      probe: async () => ok({ version: '0.0.0-fake' })
    },
    {
      onReady: callbacks.onReady,
      onCrashed: callbacks.onCrashed ? () => callbacks.onCrashed?.() : undefined
    }
  )
  supervisors.push(supervisor)
  return supervisor
}

async function waitFor(
  supervisor: DshRuntimeSupervisor,
  predicate: (snapshot: DshRuntimeSnapshot) => boolean,
  timeoutMs = 8000
): Promise<DshRuntimeSnapshot> {
  const started = Date.now()
  for (;;) {
    const snapshot = supervisor.snapshot()
    if (predicate(snapshot)) {
      return snapshot
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error(`waitFor 超时,当前快照:${JSON.stringify(supervisor.snapshot())}`)
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 25)
    })
  }
}

describe('DshRuntimeSupervisor(真子进程 + 假体)', () => {
  it('ok 模式:banner → ready(端口>0)→ SIGTERM 优雅停止', async () => {
    let readyPort: number | null = null
    const supervisor = makeSupervisor('ok', {
      onReady: (port) => {
        readyPort = port
      }
    })
    supervisor.setVersion('0.0.0-fake')
    const startResult = supervisor.start()
    expect(startResult.ok).toBe(true)
    const ready = await waitFor(supervisor, (s) => s.state === 'ready')
    expect(ready.port).not.toBeNull()
    expect(ready.port).toBeGreaterThan(0)
    expect(readyPort).toBe(ready.port)
    expect(ready.version).toBe('0.0.0-fake')
    await supervisor.stop()
    expect(supervisor.snapshot().state).toBe('stopped')
  }, 15000)

  it('die-fast 模式:退避耗尽 → stopped + NOTIFY_CRASHED', async () => {
    let crashed = 0
    const supervisor = makeSupervisor('die-fast', {
      onCrashed: () => {
        crashed += 1
      }
    })
    supervisor.setVersion('0.0.0-fake')
    supervisor.start()
    const stopped = await waitFor(supervisor, (s) => s.state === 'stopped')
    expect(stopped.restartAttempt).toBeGreaterThanOrEqual(5)
    expect(stopped.lastError).not.toBeNull()
    expect(crashed).toBe(1)
  }, 15000)

  it('autoRestart=false:崩溃直接收敛到 stopped,不进退避循环', async () => {
    const supervisor = makeSupervisor('die-fast', { autoRestart: false })
    supervisor.setVersion('0.0.0-fake')
    supervisor.start()
    const stopped = await waitFor(supervisor, (s) => s.state === 'stopped')
    expect(stopped.restartAttempt).toBeLessThan(5)
  }, 15000)

  it('无版本时 start() 返回错误', () => {
    const supervisor = new DshRuntimeSupervisor(
      {
        childFactory: realChildProcessFactory,
        spawnContractProvider: () => null,
        getAutoRestart: () => true,
        probe: async () => err('x', 'x')
      },
      {}
    )
    supervisors.push(supervisor)
    const result = supervisor.start()
    expect(result.ok).toBe(false)
    expect(result.ok ? '' : result.error.code).toBe('no-version')
  })

  it('crash-after-ready:ready 后崩溃进入退避并再次 ready', async () => {
    const supervisor = makeSupervisor('crash-after-ready')
    supervisor.setVersion('0.0.0-fake')
    supervisor.start()
    await waitFor(supervisor, (s) => s.state === 'ready')
    const again = await waitFor(
      supervisor,
      (s) => s.state === 'ready' && s.restartAttempt >= 1,
      12000
    )
    expect(again.restartAttempt).toBeGreaterThanOrEqual(1)
    await supervisor.stop()
  }, 20000)
})
