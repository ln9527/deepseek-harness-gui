import { describe, expect, it } from 'vitest'
import { resolveDesktopBuildTarget } from '../../src/main/desktop-auth/build-target'

describe('desktop Gateway build target', () => {
  it('keeps ordinary builds pinned to the production HTTPS origin', () => {
    expect(resolveDesktopBuildTarget({})).toEqual({ testVariant: false, gatewayOrigin: 'https://ds.ainativeorg.net' })
    expect(() => resolveDesktopBuildTarget({ DSH_GUI_TEST_GATEWAY_ORIGIN: 'http://127.0.0.1:47621' })).toThrow()
  })

  it('accepts only an explicit loopback origin in the test build', () => {
    expect(resolveDesktopBuildTarget({ DSH_GUI_TEST_VARIANT: '1', DSH_GUI_TEST_GATEWAY_ORIGIN: 'http://127.0.0.1:47621' }))
      .toEqual({ testVariant: true, gatewayOrigin: 'http://127.0.0.1:47621' })
    for (const origin of ['http://192.168.1.5:47621', 'http://localhost:47621', 'http://example.com', 'https://ds.ainativeorg.net',
      'http://127.0.0.1:47621/path', 'http://127.0.0.1:47621/?x=1', 'http://user@127.0.0.1:47621']) {
      expect(() => resolveDesktopBuildTarget({ DSH_GUI_TEST_VARIANT: '1', DSH_GUI_TEST_GATEWAY_ORIGIN: origin })).toThrow()
    }
  })
})
