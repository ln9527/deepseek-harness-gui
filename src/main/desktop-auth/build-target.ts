/** Build-time selection only: the packaged app never reads a Gateway URL from its runtime environment. */
export const PRODUCTION_GATEWAY_ORIGIN = 'https://ds.ainativeorg.net'

export interface DesktopBuildTarget {
  readonly testVariant: boolean
  readonly gatewayOrigin: string
}

export function resolveDesktopBuildTarget(env: Partial<Pick<NodeJS.ProcessEnv, 'DSH_GUI_TEST_VARIANT' | 'DSH_GUI_TEST_GATEWAY_ORIGIN'>>): DesktopBuildTarget {
  if (env.DSH_GUI_TEST_VARIANT !== '1') {
    if (env.DSH_GUI_TEST_VARIANT || env.DSH_GUI_TEST_GATEWAY_ORIGIN) {
      throw new Error('Test Gateway origin requires the dedicated DSH GUI Test build')
    }
    return { testVariant: false, gatewayOrigin: PRODUCTION_GATEWAY_ORIGIN }
  }
  const raw = env.DSH_GUI_TEST_GATEWAY_ORIGIN
  if (!raw) throw new Error('DSH_GUI_TEST_GATEWAY_ORIGIN is required for the test installer')
  const url = new URL(raw)
  const loopbackHttp = url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port !== ''
  if (!loopbackHttp || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.origin !== raw) {
    throw new Error('Test Gateway must be an exact loopback HTTP origin, e.g. http://127.0.0.1:47621')
  }
  return { testVariant: true, gatewayOrigin: url.origin }
}
