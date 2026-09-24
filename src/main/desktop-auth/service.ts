import type { DesktopAuthState, DesktopIdentity, DesktopProjectCardsState } from '../../shared/desktop-auth'
import type { Result } from '../../shared/contracts'
import { err, ok } from '../util/result'
import { DesktopAuthClient, DesktopAuthError, type PendingDesktopFlow } from './client'
import { DesktopCredentialStore } from './credential-store'

export interface DesktopAuthServiceDeps {
  readonly client: DesktopAuthClient
  readonly store: DesktopCredentialStore
  readonly openExternal: (url: string) => Promise<void>
  readonly deviceName: string
  readonly onState: (state: DesktopAuthState) => void
  readonly now?: () => number
  readonly setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

export class DesktopAuthService {
  private state: DesktopAuthState = { status: 'disconnected' }
  private credential: { readonly token: string; readonly user: DesktopIdentity; readonly saved: boolean;
    readonly projectCardsGrant?: string } | null = null
  private flow: PendingDesktopFlow | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private starting = false
  private readonly now: () => number
  private readonly setTimer: NonNullable<DesktopAuthServiceDeps['setTimer']>
  private readonly clearTimer: NonNullable<DesktopAuthServiceDeps['clearTimer']>

  constructor(private readonly deps: DesktopAuthServiceDeps) {
    this.now = deps.now ?? Date.now
    this.setTimer = deps.setTimer ?? setTimeout
    this.clearTimer = deps.clearTimer ?? clearTimeout
    const saved = deps.store.load()
    if (saved) {
      this.credential = { ...saved, saved: true }
      this.state = { status: 'offline', user: saved.user, saved: true }
    }
  }

  snapshot(): DesktopAuthState { return this.state }

  /** Never cache cards: every visible list is authorized by a fresh Gateway read. */
  async projectCards(): Promise<DesktopProjectCardsState> {
    const current = this.credential
    if (!current || this.state.status !== 'connected') return { status: 'offline' }
    if (!current.projectCardsGrant) return { status: 'no-grant' }
    try {
      const projects = await this.deps.client.projectCards(current.projectCardsGrant)
      return this.credential === current && this.state.status === 'connected'
        ? { status: 'ready', projects } : { status: 'offline' }
    } catch (error) {
      if (this.credential !== current || this.state.status !== 'connected') return { status: 'offline' }
      if (error instanceof DesktopAuthError && error.code === 'DESKTOP_PROJECT_GRANT_INVALID') {
        // The identity connection may still be valid. Remove only its optional
        // project authority from memory and encrypted persistence.
        const withoutGrant = { token: current.token, user: current.user }
        const saved = this.deps.store.save(withoutGrant)
        if (!saved) this.deps.store.clear()
        this.credential = { ...withoutGrant, saved }
        // Identity state contains no grant. Re-publishing an unchanged state
        // remounts the account panel before it can show the reauthorization
        // result, replacing that message with the generic no-grant hint.
        if (saved !== current.saved) this.publish({ status: 'connected', user: current.user, saved })
        return { status: 'reauthorize' }
      }
      return { status: 'unavailable' }
    }
  }

  async refresh(): Promise<void> {
    const current = this.credential
    if (!current) return
    try {
      const user = await this.deps.client.me(current.token)
      if (this.credential !== current) return
      this.credential = { ...current, user }
      this.publish({ status: 'connected', user, saved: current.saved })
    } catch (error) {
      if (this.credential !== current) return
      if (error instanceof DesktopAuthError && error.code === 'DEVICE_TOKEN_INVALID') {
        if (this.deps.store.clear()) {
          this.credential = null
          this.publish({ status: 'disconnected' })
        } else {
          this.publish({ status: 'error', message: '设备凭据已失效，但无法删除本机凭据文件。请检查应用数据目录权限。' })
        }
      } else {
        this.publish({ status: 'offline', user: current.user, saved: current.saved })
      }
    }
  }

  async start(): Promise<Result<DesktopAuthState>> {
    if (this.credential) return err('ALREADY_CONNECTED', '请先断开当前账号，再连接另一个账号')
    if (this.starting || this.flow) return err('CONNECT_IN_PROGRESS', '连接正在进行，请先取消或等待完成')
    this.starting = true
    this.stopPolling()
    try {
      const flow = await this.deps.client.start(this.deps.deviceName)
      this.flow = flow
      this.publish({ status: 'pending', userCode: flow.userCode, verificationUrl: flow.verificationUrl, expiresAt: flow.expiresAt })
      this.schedulePoll(flow.pollIntervalSeconds)
      // If the browser cannot be opened, the code and URL remain visible for manual opening.
      void this.deps.openExternal(flow.verificationUrl).catch(() => {})
      return ok(this.state)
    } catch (error) {
      return err('CONNECT_FAILED', displayError(error))
    } finally {
      this.starting = false
    }
  }

  async openVerification(): Promise<Result<null>> {
    if (!this.flow) return err('NO_PENDING_FLOW', '请先开始连接')
    try {
      await this.deps.openExternal(this.flow.verificationUrl)
      return ok(null)
    } catch {
      return err('BROWSER_UNAVAILABLE', '无法打开浏览器，请复制页面地址手动打开')
    }
  }

  async openDeviceManagement(): Promise<Result<null>> {
    try {
      await this.deps.openExternal(this.deps.client.manageUrl())
      return ok(null)
    } catch {
      return err('BROWSER_UNAVAILABLE', '无法打开组织设备管理页')
    }
  }

  cancel(): void {
    if (!this.flow) return
    this.stopPolling()
    this.publish({ status: 'disconnected' })
  }

  async disconnect(): Promise<Result<null>> {
    this.stopPolling()
    const previous = this.credential
    if (!this.deps.store.clear()) return err('LOCAL_CLEAR_FAILED', '无法删除本机凭据文件；请检查应用数据目录权限')
    this.credential = null
    this.publish({ status: 'disconnected' })
    if (!previous) return ok(null)
    try {
      await this.deps.client.logout(previous.token)
      return ok(null)
    } catch {
      return err('REMOTE_REVOKE_UNCONFIRMED', '已清除本机连接，无法确认服务端是否已撤销；请联网后到组织网页检查设备')
    }
  }

  dispose(): void { this.stopPolling() }

  private schedulePoll(seconds: number): void {
    const flow = this.flow
    if (!flow) return
    this.timer = this.setTimer(() => { void this.poll(flow) }, seconds * 1000)
  }

  private async poll(flow: PendingDesktopFlow): Promise<void> {
    if (flow !== this.flow) return
    if (this.now() >= flow.expiresAt) {
      this.stopPolling()
      this.publish({ status: 'error', message: '连接码已过期，请重新开始' })
      return
    }
    try {
      const outcome = await this.deps.client.poll(flow)
      if (flow !== this.flow) {
        if (outcome.status === 'approved') void this.deps.client.logout(outcome.token).catch(() => {})
        return
      }
      if (outcome.status === 'pending') {
        this.schedulePoll(outcome.pollIntervalSeconds)
        return
      }
      this.stopPolling()
      const credential = { token: outcome.token, user: outcome.user,
        ...(outcome.projectCardsGrant ? { projectCardsGrant: outcome.projectCardsGrant } : {}) }
      const saved = this.deps.store.save(credential)
      this.credential = { ...credential, saved }
      this.publish({ status: 'connected', user: outcome.user, saved })
    } catch (error) {
      if (flow !== this.flow) return
      if (error instanceof DesktopAuthError && error.code === 'NETWORK_UNAVAILABLE') {
        this.schedulePoll(flow.pollIntervalSeconds)
      } else {
        this.stopPolling()
        this.publish({ status: 'error', message: displayError(error) })
      }
    }
  }

  private stopPolling(): void {
    if (this.timer) this.clearTimer(this.timer)
    this.timer = null
    this.flow = null
  }

  private publish(state: DesktopAuthState): void {
    this.state = state
    this.deps.onState(state)
  }
}

function displayError(error: unknown): string {
  return error instanceof DesktopAuthError ? error.message : '组织服务返回了无法识别的响应'
}
