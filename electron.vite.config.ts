import { defineConfig } from 'electron-vite'
import { resolve } from 'node:path'
import { resolveDesktopBuildTarget } from './src/main/desktop-auth/build-target'

const desktopTarget = resolveDesktopBuildTarget(process.env)

export default defineConfig({
  main: {
    define: {
      __DSH_GUI_TEST_VARIANT__: JSON.stringify(desktopTarget.testVariant),
      __DSH_GUI_GATEWAY_ORIGIN__: JSON.stringify(desktopTarget.gatewayOrigin)
    },
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/main.ts') }
      }
    }
  },
  preload: {
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: 'src/renderer-shell',
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer-shell/index.html') }
      }
    }
  }
})
