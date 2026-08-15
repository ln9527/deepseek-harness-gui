import { describe, expect, it } from 'vitest'
import {
  computeBackoffDelay,
  initialRuntimeState,
  MAX_RESTART_ATTEMPTS,
  transition
} from '../../src/main/dsh-runtime/state-machine'

const T0 = 1_000_000

function effects(list: ReturnType<typeof transition>['effects']) {
  return list.map((e) => e.type)
}

describe('computeBackoffDelay', () => {
  it('指数序列并封顶', () => {
    expect(computeBackoffDelay(1)).toBe(1000)
    expect(computeBackoffDelay(2)).toBe(2000)
    expect(computeBackoffDelay(3)).toBe(4000)
    expect(computeBackoffDelay(4)).toBe(8000)
    expect(computeBackoffDelay(5)).toBe(16000)
    expect(computeBackoffDelay(7)).toBe(60000)
    expect(computeBackoffDelay(20, 10, 50)).toBe(50)
  })
})

describe('transition', () => {
  it('idle + START → starting(SPAWN + 看门狗)', () => {
    const t = transition(initialRuntimeState, { type: 'START' }, T0)
    expect(t.next.state).toBe('starting')
    expect(effects(t.effects)).toEqual(['SPAWN', 'START_WATCHDOG'])
  })

  it('starting + BANNER_PARSED → ready(取消看门狗 + EMIT_READY + 稳定计时)', () => {
    const starting = transition(initialRuntimeState, { type: 'START' }, T0).next
    const t = transition(starting, { type: 'BANNER_PARSED', port: 4567 }, T0 + 500)
    expect(t.next.state).toBe('ready')
    expect(t.next.port).toBe(4567)
    expect(t.next.startedAt).toBe(T0 + 500)
    expect(effects(t.effects)).toEqual(['CANCEL_WATCHDOG', 'EMIT_READY', 'SCHEDULE_STABILIZE'])
  })

  it('ready 态再收 banner 被忽略', () => {
    const ready = transition(
      transition(initialRuntimeState, { type: 'START' }, T0).next,
      { type: 'BANNER_PARSED', port: 1 },
      T0
    ).next
    const t = transition(ready, { type: 'BANNER_PARSED', port: 2 }, T0 + 1)
    expect(t.next).toBe(ready)
    expect(t.effects).toEqual([])
  })

  it('starting 意外退出 → restarting + 退避', () => {
    const starting = transition(initialRuntimeState, { type: 'START' }, T0).next
    const t = transition(starting, { type: 'EXIT', code: 1, stdioTail: ['boom'] }, T0 + 100)
    expect(t.next.state).toBe('restarting')
    expect(t.next.restartAttempt).toBe(1)
    expect(t.next.nextRestartAtMs).toBe(T0 + 100 + 1000)
    expect(t.next.lastError?.exitCode).toBe(1)
    expect(t.next.lastError?.stdioTail).toEqual(['boom'])
    expect(effects(t.effects)).toEqual(['SCHEDULE_BACKOFF'])
  })

  it('连续失败至退避耗尽 → stopped + NOTIFY_CRASHED', () => {
    let state = transition(initialRuntimeState, { type: 'START' }, T0).next
    let crashed = false
    for (let i = 1; i <= MAX_RESTART_ATTEMPTS; i++) {
      const t = transition(state, { type: 'EXIT', code: 1, stdioTail: [] }, T0 + i * 100)
      state = t.next
      if (t.effects.some((e) => e.type === 'NOTIFY_CRASHED')) {
        crashed = true
      }
      if (i < MAX_RESTART_ATTEMPTS) {
        state = transition(state, { type: 'BACKOFF_EXPIRED' }, T0 + i * 100 + 50).next
      }
    }
    expect(state.state).toBe('stopped')
    expect(state.restartAttempt).toBe(MAX_RESTART_ATTEMPTS)
    expect(crashed).toBe(true)
  })

  it('READY_STABILIZED 重置退避计数', () => {
    let state = transition(initialRuntimeState, { type: 'START' }, T0).next
    state = transition(state, { type: 'EXIT', code: 1, stdioTail: [] }, T0).next
    state = transition(state, { type: 'BACKOFF_EXPIRED' }, T0).next
    state = transition(state, { type: 'BANNER_PARSED', port: 9 }, T0).next
    expect(state.restartAttempt).toBe(1)
    state = transition(state, { type: 'READY_STABILIZED' }, T0 + 1).next
    expect(state.restartAttempt).toBe(0)
  })

  it('START_TIMEOUT → 只发 KILL,不改态', () => {
    const starting = transition(initialRuntimeState, { type: 'START' }, T0).next
    const t = transition(starting, { type: 'START_TIMEOUT' }, T0 + 20000)
    expect(t.next.state).toBe('starting')
    expect(effects(t.effects)).toEqual(['KILL'])
  })

  it('STOP_REQUEST(ready)→ stopping + KILL;随后的 EXIT → stopped(不算崩溃)', () => {
    let state = transition(initialRuntimeState, { type: 'START' }, T0).next
    state = transition(state, { type: 'BANNER_PARSED', port: 80 }, T0).next
    let t = transition(state, { type: 'STOP_REQUEST' }, T0 + 1)
    expect(t.next.state).toBe('stopping')
    expect(t.next.stoppingRequested).toBe(true)
    expect(effects(t.effects)).toEqual(['KILL'])
    t = transition(t.next, { type: 'EXIT', code: 0, stdioTail: [] }, T0 + 2)
    expect(t.next.state).toBe('stopped')
    expect(t.next.lastError).toBeNull()
  })

  it('STOP_REQUEST(restarting,无子进程)→ 直接 stopped', () => {
    let state = transition(initialRuntimeState, { type: 'START' }, T0).next
    state = transition(state, { type: 'EXIT', code: 1, stdioTail: [] }, T0).next
    expect(state.state).toBe('restarting')
    const t = transition(state, { type: 'STOP_REQUEST' }, T0 + 1)
    expect(t.next.state).toBe('stopped')
    expect(t.effects).toEqual([])
  })

  it('RESTART_NOW 从 restarting 重新出发并清零计数', () => {
    let state = transition(initialRuntimeState, { type: 'START' }, T0).next
    state = transition(state, { type: 'EXIT', code: 1, stdioTail: [] }, T0).next
    expect(state.state).toBe('restarting')
    const t = transition(state, { type: 'RESTART_NOW' }, T0)
    expect(t.next.state).toBe('starting')
    expect(t.next.restartAttempt).toBe(0)
    expect(effects(t.effects)).toEqual(['SPAWN', 'START_WATCHDOG'])
  })

  it('ready 态 EXIT(exit 0)也算意外(常驻服务不该自己退)', () => {
    const ready = transition(
      transition(initialRuntimeState, { type: 'START' }, T0).next,
      { type: 'BANNER_PARSED', port: 1 },
      T0
    ).next
    const t = transition(ready, { type: 'EXIT', code: 0, stdioTail: [] }, T0)
    expect(t.next.state).toBe('restarting')
    expect(t.next.lastError?.message).toContain('退出码 0')
  })

  it('BACKOFF_EXPIRED 仅在 restarting 态生效', () => {
    const t = transition(initialRuntimeState, { type: 'BACKOFF_EXPIRED' }, T0)
    expect(t.next).toBe(initialRuntimeState)
  })
})
