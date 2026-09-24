import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DesktopCredentialStore, type CredentialCipher } from '../../src/main/desktop-auth/credential-store'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('desktop credential persistence', () => {
  it('writes encrypted bytes, reloads through the OS cipher and removes the credential', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-auth-'))
    dirs.push(dir)
    const path = join(dir, 'credential.bin')
    const cipher: CredentialCipher = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value).reverse(),
      decryptString: (value) => value.reverse().toString('utf8')
    }
    const store = new DesktopCredentialStore(path, cipher)
    expect(store.save({ token: 'private-device-token-123', user: { username: 'alice', role: 'member' } })).toBe(true)
    expect(readFileSync(path, 'utf8')).not.toContain('private-device-token-123')
    expect(store.load()?.user.username).toBe('alice')
    store.clear()
    expect(store.load()).toBeNull()
  })

  it('never writes plaintext when encryption is unavailable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-auth-'))
    dirs.push(dir)
    const store = new DesktopCredentialStore(join(dir, 'credential.bin'), {
      isEncryptionAvailable: () => false,
      encryptString: () => { throw new Error('must not run') },
      decryptString: () => { throw new Error('must not run') }
    })
    expect(store.save({ token: 'private-device-token-123', user: { username: 'alice', role: 'member' } })).toBe(false)
    expect(store.load()).toBeNull()
  })
})
