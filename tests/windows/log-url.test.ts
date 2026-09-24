import { describe, expect, it } from 'vitest'
import { navigationTargetForLog } from '../../src/main/windows/log-url'

describe('DSH navigation logging', () => {
  it('drops the 0.1.5 banner token and every other URL credential', () => {
    const safe = navigationTargetForLog('http://127.0.0.1:4321/?token=private-web-token#secret')
    expect(safe).toBe('http://127.0.0.1:4321/')
    expect(safe).not.toContain('private-web-token')
    expect(navigationTargetForLog('https://user:password@example.test/path?key=secret')).toBe('https://example.test/path')
    expect(navigationTargetForLog('not a URL with secret')).toBe('[invalid URL]')
  })
})
