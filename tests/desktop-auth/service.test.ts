import { describe, expect, it, vi } from 'vitest'
import { DesktopAuthService } from '../../src/main/desktop-auth/service'
import { DesktopAuthError, type DesktopAuthClient } from '../../src/main/desktop-auth/client'
import type { DesktopCredentialStore } from '../../src/main/desktop-auth/credential-store'
import type { DesktopAuthState } from '../../src/shared/desktop-auth'

describe('desktop auth lifecycle', () => {
  it('keeps the token out of renderer state and does not connect before browser approval', async () => {
    const states: DesktopAuthState[] = []
    let tick: (() => void) | undefined
    let savedToken = ''
    const client = {
      start: vi.fn(async () => ({ requestId: 'id', verifier: 'private-verifier', userCode: 'ABCD', verificationUrl: 'https://ds.ainativeorg.net/auth/desktop/verify', expiresAt: 100000, pollIntervalSeconds: 5 })),
      poll: vi.fn(async () => ({ status: 'approved' as const, token: 'private-device-token', user: { username: 'alice', role: 'member' } })),
      me: vi.fn(), logout: vi.fn(async () => {})
    } as unknown as DesktopAuthClient
    const store = {
      load: () => null,
      save: (credential: { token: string }) => { savedToken = credential.token; return true },
      clear: vi.fn(() => true)
    } as unknown as DesktopCredentialStore
    const service = new DesktopAuthService({
      client, store, deviceName: 'Windows device', openExternal: vi.fn(async () => {}),
      onState: (state) => { states.push(state) }, now: () => 0,
      setTimer: (cb) => { tick = cb; return 1 as unknown as ReturnType<typeof setTimeout> },
      clearTimer: vi.fn()
    })
    expect((await service.start()).ok).toBe(true)
    expect(service.snapshot().status).toBe('pending')
    tick?.()
    await vi.waitFor(() => expect(service.snapshot().status).toBe('connected'))
    expect(savedToken).toBe('private-device-token')
    expect(JSON.stringify(states)).not.toContain('private-device-token')
    expect(JSON.stringify(states)).not.toContain('private-verifier')
  })

  it('keeps cached identity offline until verified and clears invalid credentials', async () => {
    const store = {
      load: () => ({ token: 'private-device-token', user: { username: 'alice', role: 'member' } }),
      save: vi.fn(), clear: vi.fn(() => true)
    } as unknown as DesktopCredentialStore
    const client = {
      me: vi.fn(async () => { throw new DesktopAuthError('DEVICE_TOKEN_INVALID', 'invalid') })
    } as unknown as DesktopAuthClient
    const service = new DesktopAuthService({ client, store, deviceName: 'Windows device', openExternal: vi.fn(async () => {}), onState: vi.fn() })
    expect(service.snapshot().status).toBe('offline')
    await service.refresh()
    expect(service.snapshot().status).toBe('disconnected')
    expect(store.clear).toHaveBeenCalledOnce()
  })
})
