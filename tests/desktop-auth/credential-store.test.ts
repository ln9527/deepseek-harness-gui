import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    const store = new DesktopCredentialStore(path, cipher, 'https://ds.ainativeorg.net')
    expect(store.save({ token: 'private-device-token-123', user: { username: 'alice', role: 'member' } })).toBe(true)
    expect(readFileSync(path, 'utf8')).not.toContain('private-device-token-123')
    expect(store.load()?.user.username).toBe('alice')
    // A bundle pointed at another Gateway must never refresh with this Bearer.
    const otherOrigin = new DesktopCredentialStore(path, cipher, 'http://127.0.0.1:47621')
    expect(otherOrigin.load()).toBeNull()
    expect(store.load()?.token).toBe('private-device-token-123')
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
    }, 'https://ds.ainativeorg.net')
    expect(store.save({ token: 'private-device-token-123', user: { username: 'alice', role: 'member' } })).toBe(false)
    expect(store.load()).toBeNull()
  })

  it('does not load a legacy encrypted token without an origin', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-auth-'))
    dirs.push(dir)
    const path = join(dir, 'credential.bin')
    const cipher: CredentialCipher = {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value).reverse(),
      decryptString: (value) => value.reverse().toString('utf8')
    }
    writeFileSync(path, cipher.encryptString(JSON.stringify({
      token: 'legacy-private-device-token', user: { username: 'alice', role: 'member' }
    })))
    expect(new DesktopCredentialStore(path, cipher, 'https://ds.ainativeorg.net').load()).toBeNull()
  })
})
