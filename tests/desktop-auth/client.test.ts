import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { DesktopAuthClient } from '../../src/main/desktop-auth/client'

describe('desktop device auth wire', () => {
  it('keeps verifier local and sends only its hash to start; refuses foreign verification URLs', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = []
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      requests.push({ url: url.toString(), init })
      return Response.json({
        requestId: 'request-1', userCode: 'ABCD-EFGH',
        verificationUrl: '/auth/desktop/verify',
        expiresInSeconds: 600, pollIntervalSeconds: 5
      })
    }) as unknown as typeof fetch
    const client = new DesktopAuthClient('https://ds.ainativeorg.net', fetcher, () => 1000)
    const flow = await client.start('DSH GUI (Windows)')
    expect(flow.verifier).toBeTruthy()
    expect(flow.verificationUrl).toBe('https://ds.ainativeorg.net/auth/desktop/verify')
    expect(flow.expiresAt).toBe(601000)
    const body = JSON.parse(requests[0]!.init.body as string) as { challenge: string; deviceName: string }
    expect(body).not.toHaveProperty('verifier')
    expect(body.challenge).toBe(createHash('sha256').update(flow.verifier, 'utf8').digest('base64url'))
    expect(requests[0]!.init.headers).toMatchObject({ Origin: 'https://ds.ainativeorg.net', 'x-dsh-desktop-client': '1' })
    expect(requests[0]!.init).not.toHaveProperty('credentials')

    const badFetcher = vi.fn(async () => Response.json({
      requestId: 'request-2', userCode: 'ABCD-EFGH', verificationUrl: 'https://phishing.example/auth/desktop/verify',
      expiresInSeconds: 600, pollIntervalSeconds: 5
    })) as unknown as typeof fetch
    await expect(new DesktopAuthClient('https://ds.ainativeorg.net', badFetcher).start('device')).rejects.toMatchObject({ code: 'INVALID_VERIFICATION_URL' })
  })

  it('uses Bearer only on the device identity endpoint and parses revocation', async () => {
    const requests: RequestInit[] = []
    const fetcher = vi.fn(async (_url: URL, init: RequestInit) => {
      requests.push(init)
      return Response.json({ user: { username: 'alice', role: 'member' } })
    }) as unknown as typeof fetch
    const user = await new DesktopAuthClient('https://ds.ainativeorg.net', fetcher).me('secret-token')
    expect(user.username).toBe('alice')
    expect(requests[0]!.headers).toMatchObject({ Authorization: 'Bearer secret-token' })
  })

  it('parses the optional grant and reads only the five project card fields with that Bearer', async () => {
    const requests: Array<{ url: string; init: RequestInit }> = []
    const grant = 'g'.repeat(43)
    const fetcher = vi.fn(async (url: URL, init: RequestInit) => {
      requests.push({ url: url.toString(), init })
      if (url.pathname.endsWith('/poll')) return Response.json({ status: 'approved', token: 'private-identity-token',
        projectCardsGrant: grant, user: { username: 'alice', role: 'member' } })
      return Response.json({ projects: [{ projectId: 'proj_1', title: 'A', owner: 'alice',
        role: 'owner', updatedAt: '2026-09-25T00:00:00.000Z' }] })
    }) as unknown as typeof fetch
    const client = new DesktopAuthClient('https://ds.ainativeorg.net', fetcher)
    const approved = await client.poll({ requestId: 'r', verifier: 'v', userCode: 'CODE',
      verificationUrl: 'https://ds.ainativeorg.net/auth/desktop/verify', expiresAt: 12345, pollIntervalSeconds: 5 })
    expect(approved).toMatchObject({ status: 'approved', projectCardsGrant: grant })
    expect((await client.projectCards(grant))[0]?.title).toBe('A')
    expect(requests[1]?.url).toBe('https://ds.ainativeorg.net/auth/desktop/project-cards')
    expect(requests[1]?.init.headers).toMatchObject({ Authorization: `Bearer ${grant}` })
    expect(requests[1]?.init).not.toHaveProperty('credentials')

    const oversharing = vi.fn(async () => Response.json({ projects: [{ projectId: 'proj_1',
      title: 'A', owner: 'alice', role: 'owner', updatedAt: '2026-09-25T00:00:00.000Z', collaborators: ['bob'] }] })) as unknown as typeof fetch
    await expect(new DesktopAuthClient('https://ds.ainativeorg.net', oversharing).projectCards(grant)).rejects.toThrow()
  })

  it('explains an unopened gateway and accepts local HTTP only for loopback tests', async () => {
    const fetcher = vi.fn(async () => Response.json({ code: 'NOT_FOUND' }, { status: 404 })) as unknown as typeof fetch
    const client = new DesktopAuthClient('http://127.0.0.1:9999', fetcher)
    await expect(client.start('device')).rejects.toMatchObject({
      message: '此组织服务尚未启用桌面连接，或当前网关版本不支持'
    })
    expect(() => new DesktopAuthClient('http://example.com', fetcher)).toThrow()
  })
})
