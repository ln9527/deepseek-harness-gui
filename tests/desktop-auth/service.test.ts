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

  it('updates a running connection after browser revocation without restarting DSH', async () => {
    const store = {
      load: () => ({ token: 'private-device-token', user: { username: 'alice', role: 'member' } }),
      save: vi.fn(), clear: vi.fn(() => true)
    } as unknown as DesktopCredentialStore
    const me = vi.fn()
      .mockResolvedValueOnce({ username: 'alice', role: 'member' })
      .mockRejectedValueOnce(new DesktopAuthError('DEVICE_TOKEN_INVALID', 'revoked'))
    const client = { me } as unknown as DesktopAuthClient
    const service = new DesktopAuthService({ client, store, deviceName: 'Windows device', openExternal: vi.fn(async () => {}), onState: vi.fn() })
    await service.refresh()
    expect(service.snapshot().status).toBe('connected')
    await service.refresh()
    expect(service.snapshot().status).toBe('disconnected')
    expect(store.clear).toHaveBeenCalledOnce()
  })

  it('keeps an opt-in grant in main storage and shows cards only after a fresh read', async () => {
    let tick: (() => void) | undefined
    const grant = 'g'.repeat(43)
    const saved: unknown[] = []
    const cards = vi.fn(async () => [{ projectId: 'proj_1', title: 'Project', owner: 'alice',
      role: 'owner' as const, updatedAt: '2026-09-25T00:00:00.000Z' }])
    const client = {
      start: vi.fn(async () => ({ requestId: 'id', verifier: 'secret-verifier', userCode: 'CODE',
        verificationUrl: 'https://ds.ainativeorg.net/auth/desktop/verify', expiresAt: 100000, pollIntervalSeconds: 5 })),
      poll: vi.fn(async () => ({ status: 'approved' as const, token: 'private-identity-token',
        projectCardsGrant: grant, user: { username: 'alice', role: 'member' } })),
      projectCards: cards, me: vi.fn(async () => { throw new DesktopAuthError('NETWORK_UNAVAILABLE', 'offline') }),
      logout: vi.fn(async () => {})
    } as unknown as DesktopAuthClient
    const store = { load: () => null, save: (credential: unknown) => { saved.push(credential); return true },
      clear: vi.fn(() => true) } as unknown as DesktopCredentialStore
    const states: DesktopAuthState[] = []
    const service = new DesktopAuthService({ client, store, deviceName: 'Windows device',
      openExternal: vi.fn(async () => {}), onState: (state) => { states.push(state) }, now: () => 0,
      setTimer: (cb) => { tick = cb; return 1 as unknown as ReturnType<typeof setTimeout> },
      clearTimer: vi.fn() })
    expect((await service.start()).ok).toBe(true)
    tick?.()
    await vi.waitFor(() => expect(service.snapshot().status).toBe('connected'))
    expect(saved).toEqual([{ token: 'private-identity-token', projectCardsGrant: grant,
      user: { username: 'alice', role: 'member' } }])
    expect(JSON.stringify(states)).not.toContain(grant)
    expect(JSON.stringify(states)).not.toContain('private-identity-token')
    expect(await service.projectCards()).toMatchObject({ status: 'ready', projects: [{ title: 'Project' }] })
    expect(cards).toHaveBeenCalledWith(grant)
    await service.refresh()
    expect(await service.projectCards()).toEqual({ status: 'offline' })
    expect(cards).toHaveBeenCalledTimes(1)
  })

  it('removes only a revoked project grant and tells an old device to reauthorize', async () => {
    const grant = 'g'.repeat(43)
    const save = vi.fn(() => true)
    const store = { load: () => ({ token: 'private-identity-token', projectCardsGrant: grant,
      user: { username: 'alice', role: 'member' } }), save, clear: vi.fn(() => true) } as unknown as DesktopCredentialStore
    const client = { me: vi.fn(async () => ({ username: 'alice', role: 'member' })),
      projectCards: vi.fn(async () => { throw new DesktopAuthError('DESKTOP_PROJECT_GRANT_INVALID', 'revoked') })
    } as unknown as DesktopAuthClient
    const onState = vi.fn()
    const service = new DesktopAuthService({ client, store, deviceName: 'Windows device',
      openExternal: vi.fn(async () => {}), onState })
    expect(await service.projectCards()).toEqual({ status: 'offline' })
    await service.refresh()
    const publishedBeforeGrantRevocation = onState.mock.calls.length
    expect(await service.projectCards()).toEqual({ status: 'reauthorize' })
    expect(onState.mock.calls.length).toBe(publishedBeforeGrantRevocation)
    expect(save).toHaveBeenCalledWith({ token: 'private-identity-token',
      user: { username: 'alice', role: 'member' } })
    expect(service.snapshot().status).toBe('connected')
    expect(await service.projectCards()).toEqual({ status: 'no-grant' })
  })

  it('keeps a pre-project-card pairing identity-only until the person reauthorizes', async () => {
    const projectCards = vi.fn()
    const store = { load: () => ({ token: 'old-identity-token',
      user: { username: 'alice', role: 'member' } }), save: vi.fn(), clear: vi.fn() } as unknown as DesktopCredentialStore
    const client = { me: vi.fn(async () => ({ username: 'alice', role: 'member' })),
      projectCards } as unknown as DesktopAuthClient
    const service = new DesktopAuthService({ client, store, deviceName: 'Windows device',
      openExternal: vi.fn(async () => {}), onState: vi.fn() })
    await service.refresh()
    expect(service.snapshot().status).toBe('connected')
    expect(await service.projectCards()).toEqual({ status: 'no-grant' })
    expect(projectCards).not.toHaveBeenCalled()
  })

  it('never releases an in-flight project list after local disconnect', async () => {
    let resolveCards: ((value: unknown) => void) | undefined
    const client = { me: vi.fn(async () => ({ username: 'alice', role: 'member' })),
      projectCards: vi.fn(() => new Promise(resolve => { resolveCards = resolve })), logout: vi.fn(async () => {})
    } as unknown as DesktopAuthClient
    const store = { load: () => ({ token: 'private-identity-token', projectCardsGrant: 'g'.repeat(43),
      user: { username: 'alice', role: 'member' } }), save: vi.fn(), clear: vi.fn(() => true) } as unknown as DesktopCredentialStore
    const service = new DesktopAuthService({ client, store, deviceName: 'Windows device',
      openExternal: vi.fn(async () => {}), onState: vi.fn() })
    await service.refresh()
    const pending = service.projectCards()
    await service.disconnect()
    resolveCards?.([{ projectId: 'proj_1', title: 'Stale', owner: 'alice', role: 'owner', updatedAt: '2026-09-25T00:00:00.000Z' }])
    expect(await pending).toEqual({ status: 'offline' })
  })
})
