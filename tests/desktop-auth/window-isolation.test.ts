import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IpcChannel } from '../../src/shared/ipc-types'
import type { IpcDeps } from '../../src/main/ipc/register'
import { registerIpc } from '../../src/main/ipc/register'
import { ManageWindowController } from '../../src/main/windows/manage-window'

const handlers = new Map<string, (event: { sender: { id: number } }, payload?: unknown) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: (channel: string, handler: (event: { sender: { id: number } }, payload?: unknown) => unknown) => { handlers.set(channel, handler) } },
  BrowserWindow: { getAllWindows: () => [] }
}))

beforeEach(() => { handlers.clear() })

describe('desktop identity window boundary', () => {
  it('rejects a DSH page asking for identity or project cards through the shared preload', async () => {
    const deps = {
      desktopAuth: { snapshot: () => ({ status: 'connected', user: { username: 'alice', role: 'member' }, saved: true }),
        projectCards: async () => ({ status: 'ready', projects: [{ projectId: 'p', title: 'Card', owner: 'alice', role: 'owner', updatedAt: '2026-09-25T00:00:00.000Z' }] }) },
      actions: { isManageWebContents: (id: number) => id === 1 }
    } as unknown as IpcDeps
    registerIpc(deps)
    const get = handlers.get(IpcChannel.DesktopAuthGet)!
    expect(get({ sender: { id: 2 } })).toMatchObject({ ok: false, error: { code: 'AUTH_IPC_FORBIDDEN' } })
    expect(get({ sender: { id: 1 } })).toMatchObject({ status: 'connected', user: { username: 'alice' } })
    const cards = handlers.get(IpcChannel.DesktopProjectCardsGet)!
    expect(cards({ sender: { id: 2 } })).toMatchObject({ ok: false, error: { code: 'AUTH_IPC_FORBIDDEN' } })
    expect(await cards({ sender: { id: 1 } })).toMatchObject({ status: 'ready', projects: [{ title: 'Card' }] })
  })

  it('pushes identity only to the manage window, never all windows', () => {
    const send = vi.fn()
    const manage = new ManageWindowController({ devServerUrl: null, rendererDistDir: '', preloadPath: '' })
    ;(manage as unknown as { window: unknown }).window = {
      isDestroyed: () => false,
      webContents: { id: 1, send }
    }
    manage.sendDesktopAuth({ status: 'connected', user: { username: 'alice', role: 'member' }, saved: true })
    expect(send).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledWith(IpcChannel.DesktopAuthChanged, expect.objectContaining({ status: 'connected' }))
  })
})
