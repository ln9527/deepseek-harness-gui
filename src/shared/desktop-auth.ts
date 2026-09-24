/** The renderer receives identity and connection state, never device credentials. */
export interface DesktopIdentity {
  readonly username: string
  readonly role: string
}

/** Project metadata only. The grant and collaborator list stay in the main process/Gateway. */
export interface DesktopProjectCard {
  readonly projectId: string
  readonly title: string
  readonly owner: string
  readonly role: 'owner' | 'member' | 'administrator'
  readonly updatedAt: string
}

export type DesktopProjectCardsState =
  | { readonly status: 'ready'; readonly projects: readonly DesktopProjectCard[] }
  | { readonly status: 'no-grant' | 'reauthorize' | 'offline' | 'unavailable' }

export type DesktopAuthState =
  | { readonly status: 'disconnected' }
  | { readonly status: 'pending'; readonly userCode: string; readonly expiresAt: number; readonly verificationUrl: string }
  | { readonly status: 'connected'; readonly user: DesktopIdentity; readonly saved: boolean }
  | { readonly status: 'offline'; readonly user: DesktopIdentity; readonly saved: boolean }
  | { readonly status: 'error'; readonly message: string }
