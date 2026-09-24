import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { DesktopIdentity, DesktopProjectCard } from '../../shared/desktop-auth'
const identitySchema = z.object({ username: z.string().min(1), role: z.string().min(1) })
const startSchema = z.object({
  requestId: z.string().min(1),
  userCode: z.string().min(1),
  verificationUrl: z.string().min(1),
  expiresInSeconds: z.number().int().positive().max(600),
  pollIntervalSeconds: z.number().int().min(1).max(60)
})
const pollSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending'), pollIntervalSeconds: z.number().int().min(1).max(60) }),
  z.object({ status: z.literal('approved'), token: z.string().min(20), user: identitySchema,
    projectCardsGrant: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional() })
])
const meSchema = z.object({ user: identitySchema })
const errorSchema = z.object({ code: z.string() })
const projectCardSchema = z.strictObject({
  projectId: z.string().min(1), title: z.string(), owner: z.string().min(1),
  role: z.enum(['owner', 'member', 'administrator']), updatedAt: z.string().datetime()
})
const projectCardsSchema = z.strictObject({ projects: z.array(projectCardSchema) })

export interface PendingDesktopFlow {
  readonly requestId: string
  readonly verifier: string
  readonly userCode: string
  readonly verificationUrl: string
  readonly expiresAt: number
  readonly pollIntervalSeconds: number
}

export type PollOutcome =
  | { readonly status: 'pending'; readonly pollIntervalSeconds: number }
  | { readonly status: 'approved'; readonly token: string; readonly user: DesktopIdentity; readonly projectCardsGrant?: string }

export class DesktopAuthError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

/** Only this narrowly scoped client knows the desktop-auth wire protocol. */
export class DesktopAuthClient {
  constructor(
    private readonly origin: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now
  ) {
    const parsed = new URL(origin)
    const localHttp = parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
    if ((!localHttp && parsed.protocol !== 'https:') || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('Desktop gateway must be an HTTPS origin (local HTTP is test-only)')
    }
  }

  manageUrl(): string {
    return new URL('/auth/desktop/manage', this.origin).toString()
  }

  async start(deviceName: string): Promise<PendingDesktopFlow> {
    const verifier = randomBytes(32).toString('base64url')
    const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url')
    const data = startSchema.parse(await this.request('/auth/desktop/start', {
      method: 'POST', body: JSON.stringify({ challenge, deviceName })
    }))
    const verify = new URL(data.verificationUrl, this.origin)
    if (verify.origin !== this.origin || verify.pathname !== '/auth/desktop/verify' || verify.username || verify.password || verify.hash) {
      throw new DesktopAuthError('INVALID_VERIFICATION_URL', '服务端返回了非预期的验证地址')
    }
    return { ...data, verificationUrl: verify.toString(), verifier, expiresAt: this.now() + data.expiresInSeconds * 1000 }
  }

  async poll(flow: PendingDesktopFlow): Promise<PollOutcome> {
    return pollSchema.parse(await this.request('/auth/desktop/poll', {
      method: 'POST', body: JSON.stringify({ requestId: flow.requestId, verifier: flow.verifier })
    }))
  }

  async me(token: string): Promise<DesktopIdentity> {
    return meSchema.parse(await this.request('/auth/desktop/me', { method: 'GET', token })).user
  }

  async projectCards(grant: string): Promise<readonly DesktopProjectCard[]> {
    return projectCardsSchema.parse(await this.request('/auth/desktop/project-cards', { method: 'GET', token: grant })).projects
  }

  async logout(token: string): Promise<void> {
    await this.request('/auth/desktop/logout', { method: 'POST', token })
  }

  private async request(path: string, options: { readonly method: 'GET' | 'POST'; readonly body?: string; readonly token?: string }): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetcher(new URL(path, this.origin), {
        method: options.method,
        headers: {
          Accept: 'application/json',
          Origin: this.origin,
          'x-dsh-desktop-client': '1',
          ...(options.body ? { 'Content-Type': 'application/json' } : {}),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {})
        },
        body: options.body,
        signal: AbortSignal.timeout(10000),
        redirect: 'error'
      })
    } catch {
      throw new DesktopAuthError('NETWORK_UNAVAILABLE', '无法连接组织服务')
    }
    const data: unknown = await response.json().catch(() => null)
    if (!response.ok) {
      const code = errorSchema.safeParse(data).data?.code ?? 'GATEWAY_ERROR'
      const message = response.status === 404 ? '此组织服务尚未启用桌面连接，或当前网关版本不支持'
        : code === 'DEVICE_FLOW_EXPIRED' ? '连接码已过期，请重新开始'
        : code === 'DEVICE_FLOW_DENIED' ? '这次设备连接已被拒绝'
        : code === 'DEVICE_TOKEN_INVALID' ? '设备连接已失效或到期，请重新连接'
        : code === 'DESKTOP_PROJECT_GRANT_INVALID' ? '项目卡授权已失效，请重新连接并授权'
        : `组织服务暂时无法完成请求 (${response.status})`
      throw new DesktopAuthError(code, message)
    }
    return data
  }
}
