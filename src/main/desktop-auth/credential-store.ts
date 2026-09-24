import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import type { DesktopIdentity } from '../../shared/desktop-auth'

const credentialSchema = z.object({ origin: z.string().url(), token: z.string().min(20),
  projectCardsGrant: z.string().regex(/^[A-Za-z0-9_-]{43}$/).optional(),
  user: z.object({ username: z.string().min(1), role: z.string().min(1) }) })

export interface StoredDesktopCredential {
  readonly token: string
  readonly user: DesktopIdentity
  readonly projectCardsGrant?: string
}

export interface CredentialCipher {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

/** OS-backed encryption only. A missing keychain yields a session-only connection. */
export class DesktopCredentialStore {
  constructor(private readonly path: string, private readonly cipher: CredentialCipher, private readonly origin: string) {}

  load(): StoredDesktopCredential | null {
    if (!this.cipher.isEncryptionAvailable() || !existsSync(this.path)) return null
    try {
      const plain = this.cipher.decryptString(readFileSync(this.path))
      const credential = credentialSchema.parse(JSON.parse(plain))
      if (credential.origin !== this.origin) return null
      return { token: credential.token, user: credential.user,
        ...(credential.projectCardsGrant ? { projectCardsGrant: credential.projectCardsGrant } : {}) }
    } catch {
      // A corrupt or account-inaccessible ciphertext must never be treated as a login.
      return null
    }
  }

  save(credential: StoredDesktopCredential): boolean {
    if (!this.cipher.isEncryptionAvailable()) return false
    const validated = credentialSchema.parse({ ...credential, origin: this.origin })
    const tmp = `${this.path}.tmp-${process.pid}`
    try {
      writeFileSync(tmp, this.cipher.encryptString(JSON.stringify(validated)), { mode: 0o600 })
      renameSync(tmp, this.path)
      return true
    } catch {
      try { unlinkSync(tmp) } catch { /* best effort */ }
      return false
    }
  }

  clear(): boolean {
    try {
      unlinkSync(this.path)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ENOENT'
    }
  }
}
