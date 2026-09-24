/** The renderer receives identity and connection state, never device credentials. */
export interface DesktopIdentity {
  readonly username: string
  readonly role: string
}

export type DesktopAuthState =
  | { readonly status: 'disconnected' }
  | { readonly status: 'pending'; readonly userCode: string; readonly expiresAt: number; readonly verificationUrl: string }
  | { readonly status: 'connected'; readonly user: DesktopIdentity; readonly saved: boolean }
  | { readonly status: 'offline'; readonly user: DesktopIdentity; readonly saved: boolean }
  | { readonly status: 'error'; readonly message: string }
