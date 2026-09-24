import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DesktopAuthClient } from '../../src/main/desktop-auth/client'

const silentLog = { info() {}, warn() {}, error() {} }

async function post(origin: string, path: string, body: object, cookie?: string) {
  const response = await fetch(`${origin}${path}`, {
    method: 'POST', headers: {
      origin, 'content-type': 'application/json', 'cf-connecting-ip': '203.0.113.7',
      ...(cookie ? { cookie } : {})
    }, body: JSON.stringify(body)
  })
  const json = await response.json()
  return { status: response.status, json, cookie: response.headers.get('set-cookie') }
}

describe('real HTTP GUI↔Gateway device contract', () => {
  const gatewayRoot = process.env.DSH_GATEWAY_SOURCE
  it.skipIf(!gatewayRoot)('start → browser approval → poll → me → logout; denial, disabled door and offline', async () => {
    // Optional cross-repo contract suite; regular GUI CI has no Gateway checkout.
    const gatewayModule = (name: string): Promise<any> => import(/* @vite-ignore */ pathToFileURL(join(gatewayRoot!, 'gateway/src', name)).href)
    const [{ AuthStore }, { loadConfig }, { createGateway }, { LoginThrottle }] = await Promise.all([
      gatewayModule('auth-store.js'), gatewayModule('config.js'), gatewayModule('server.js'), gatewayModule('throttle.js')
    ])
    const dir = mkdtempSync(join(tmpdir(), 'dsh-gui-gateway-'))
    const config = loadConfig({ GATEWAY_DB_PATH: join(dir, 'identity.sqlite3'), GATEWAY_DESKTOP_AUTH_ENABLED: '1' })
    const store = new AuthStore({ dbPath: config.dbPath })
    let server: ReturnType<typeof createGateway> | undefined
    try {
      await store.createUser('synthetic-member', 'correct-horse-battery')
      server = createGateway({ store, config, throttle: new LoginThrottle(), log: silentLog })
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      const fetcher: typeof fetch = (input, init) => fetch(input, {
        ...init, headers: { ...init?.headers, 'cf-connecting-ip': '203.0.113.7' }
      })
      const client = new DesktopAuthClient(origin, fetcher)
      const flow = await client.start('Synthetic Windows')
      expect(flow.verificationUrl).toBe(`${origin}/auth/desktop/verify`)
      expect((await client.poll(flow)).status).toBe('pending')
      const login = await post(origin, '/auth/login', { username: 'synthetic-member', password: 'correct-horse-battery' })
      expect(login.status).toBe(200)
      const cookie = login.cookie!.split(';')[0]
      const approval = await post(origin, '/auth/desktop/approve', { userCode: flow.userCode, approve: true, expectedAccount: 'synthetic-member' }, cookie)
      expect(approval.status).toBe(200)
      const claimed = await client.poll(flow)
      expect(claimed.status).toBe('approved')
      if (claimed.status !== 'approved') throw new Error('expected approval')
      expect(await client.me(claimed.token)).toEqual({ username: 'synthetic-member', role: 'member' })
      await client.logout(claimed.token)
      await expect(client.me(claimed.token)).rejects.toMatchObject({ code: 'DEVICE_TOKEN_INVALID' })

      const denied = await client.start('Denied Windows')
      const rejection = await post(origin, '/auth/desktop/approve', { userCode: denied.userCode, approve: false, expectedAccount: 'synthetic-member' }, cookie)
      expect(rejection.status).toBe(200)
      await expect(client.poll(denied)).rejects.toMatchObject({ code: 'DEVICE_FLOW_DENIED' })

      const disabled = createGateway({ store, config: { ...config, desktopAuthEnabled: false }, throttle: new LoginThrottle(), log: silentLog })
      await new Promise<void>(resolve => disabled.listen(0, '127.0.0.1', resolve))
      const disabledOrigin = `http://127.0.0.1:${(disabled.address() as { port: number }).port}`
      try {
        await expect(new DesktopAuthClient(disabledOrigin, fetcher).start('Disabled')).rejects.toMatchObject({
          message: '此组织服务尚未启用桌面连接，或当前网关版本不支持'
        })
      } finally {
        disabled.closeAllConnections()
        await new Promise<void>(resolve => disabled.close(resolve))
      }
      server.closeAllConnections()
      await new Promise<void>(resolve => server!.close(resolve))
      server = undefined
      await expect(client.start('Offline Windows')).rejects.toMatchObject({ code: 'NETWORK_UNAVAILABLE' })
    } finally {
      if (server) {
        server.closeAllConnections()
        await new Promise<void>(resolve => server!.close(resolve))
      }
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(!gatewayRoot)('browser opt-in → separate project grant → current ACL → device revocation', async () => {
    const gatewayModule = (name: string): Promise<any> => import(/* @vite-ignore */ pathToFileURL(join(gatewayRoot!, 'gateway/src', name)).href)
    const [{ AuthStore }, { loadConfig }, { createGateway }, { LoginThrottle }, { createOrgStore },
      { readOrgMembership }, { classPoliciesFor }] = await Promise.all([
      gatewayModule('auth-store.js'), gatewayModule('config.js'), gatewayModule('server.js'),
      gatewayModule('throttle.js'), gatewayModule('org/store.js'), gatewayModule('org/membership.js'),
      import(/* @vite-ignore */ pathToFileURL(join(gatewayRoot!, 'gateway/test/org-support.mjs')).href)
    ])
    const dir = mkdtempSync(join(tmpdir(), 'dsh-gui-project-cards-'))
    const config = loadConfig({ GATEWAY_DB_PATH: join(dir, 'identity.sqlite3'), GATEWAY_DESKTOP_AUTH_ENABLED: '1' })
    const store = new AuthStore({ dbPath: config.dbPath })
    const orgStore = createOrgStore({ dbPath: join(dir, 'org.sqlite3') })
    let server: ReturnType<typeof createGateway> | undefined
    try {
      await store.createUser('alice', 'correct-horse-battery')
      await store.createUser('bob', 'correct-horse-battery')
      orgStore.ensureMembers(['alice', 'bob'].map(account => ({ account, displayName: account, orgId: 'org-a' })))
      const project = orgStore.projects.create({ orgId: 'org-a', title: 'Synthetic project', owner: 'alice' }).project
      expect(orgStore.projects.addCollaborator({ projectId: project.projectId, account: 'bob', addedBy: 'alice' }).ok).toBe(true)
      const orgMembership = readOrgMembership(JSON.stringify({ version: 1,
        orgs: { 'org-a': { displayName: 'A' } }, accounts: { alice: 'org-a', bob: 'org-a' } }))
      server = createGateway({ store, orgStore, orgMembership, classPolicies: classPoliciesFor(),
        config, throttle: new LoginThrottle(), log: silentLog })
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      const fetcher: typeof fetch = (input, init) => fetch(input, {
        ...init, headers: { ...init?.headers, 'cf-connecting-ip': '203.0.113.7' }
      })
      const client = new DesktopAuthClient(origin, fetcher)
      const flow = await client.start('Synthetic Windows')
      const login = await post(origin, '/auth/login', { username: 'bob', password: 'correct-horse-battery' })
      expect(login.status).toBe(200)
      const approval = await post(origin, '/auth/desktop/approve', {
        userCode: flow.userCode, approve: true, projectCards: true, expectedAccount: 'bob'
      }, login.cookie!.split(';')[0])
      expect(approval.status).toBe(200)
      const claimed = await client.poll(flow)
      expect(claimed.status).toBe('approved')
      if (claimed.status !== 'approved') throw new Error('expected approval')
      expect(claimed.projectCardsGrant).toMatch(/^[A-Za-z0-9_-]{43}$/)
      expect(claimed.projectCardsGrant).not.toBe(claimed.token)
      expect(await client.projectCards(claimed.projectCardsGrant!)).toEqual([{
        projectId: project.projectId, title: 'Synthetic project', owner: 'alice',
        role: 'member', updatedAt: project.updatedAt
      }])
      await expect(client.projectCards(claimed.token)).rejects.toMatchObject({ code: 'DESKTOP_PROJECT_GRANT_INVALID' })
      expect(orgStore.projects.removeCollaborator({ projectId: project.projectId, account: 'bob' }).ok).toBe(true)
      expect(await client.projectCards(claimed.projectCardsGrant!)).toEqual([])
      await client.logout(claimed.token)
      await expect(client.projectCards(claimed.projectCardsGrant!)).rejects.toMatchObject({ code: 'DESKTOP_PROJECT_GRANT_INVALID' })
    } finally {
      if (server) {
        server.closeAllConnections()
        await new Promise<void>(resolve => server!.close(resolve))
      }
      orgStore.close()
      store.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
