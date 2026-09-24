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
    expect(body.challenge).toBe(createHash('sha256').update(Buffer.from(flow.verifier, 'base64url')).digest('base64url'))
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
})
