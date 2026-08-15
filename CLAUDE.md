# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

DSH GUI — an Electron (100% TypeScript) desktop shell for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH), published at https://github.com/ln9527/deepseek-harness-gui. The architectural iron rule: **the shell is a process manager + browser container**. It never forks DSH, never copies its frontend, never parses DSH internal storage — this is what keeps it alive across DSH's rapid developer-preview releases (documented breaking changes, no protocol versioning).

## Commands

```bash
pnpm dev        # dev mode (HMR); opens a real window on this Mac
pnpm test       # vitest, all tests
pnpm test -- tests/notify-bridge/dedupe.test.ts        # single file
pnpm test -- -t "退避"                                  # single test by name
pnpm typecheck  # two tsconfigs (node + web), both must pass
pnpm icons      # regenerate app/tray icons (pure-node PNG writer in scripts/gen-icons.mjs)
pnpm fetch:runtime [--platform win32]   # materialize bundled DSH tree (skips if present)
pnpm dist       # macOS arm64 .dmg (self-contained, runs fetch:runtime first)
pnpm dist:win   # Windows x64 NSIS .exe, cross-built FROM macOS (runs fetch:runtime --platform win32)
```

Setup quirks: pnpm 10 blocks postinstall scripts — if `node_modules/electron/dist/version` is missing after install, run `node node_modules/electron/install.js`.

## Architecture — the parts that span files

**Upstream coupling is confined to 4 adapter files.** When a DSH release changes behavior, adaptation happens only in: `src/main/dsh-runtime/banner-parser.ts` (stdout readiness line `dsh web: http://127.0.0.1:<port>`), `src/main/dsh-runtime/describe-probe.ts` (`POST /api/host.describe` four-quadrant envelope), the spawn contract in `src/main/main.ts` (`buildSpawnContract`), and `src/main/notify-bridge/ws-frame-schemas.ts`. Everything else depends only on these modules' output types.

**Runtime lifecycle** is a pure reducer (`dsh-runtime/state-machine.ts`: state × event → next state + effect list, zero IO/timers — fully table-driven tested) executed by `DshRuntimeSupervisor` (`supervisor.ts`), which owns the child process, watchdog, and backoff timers. Crash handling: exponential backoff 1s→60s, gives up after 5 consecutive failures; tests inject `backoffBaseMs` to keep them fast.

**Version resolution order** (`dsh-versions/registry.ts` `resolveActiveVersion`): pinned → user-installed (highest) → **bundled** (highest) → null. Bundled runtimes live in `resources/dsh-runtime/` (darwin) / `resources/dsh-runtime-win/` (win32, cross-installed via `npm --os=win32 --cpu=x64 --ignore-scripts` — koffi/sharp/require-builtin ship official platform prebuild packages; node-pty bundles ConPTY prebuilds for all platforms; none need local compilation). Both trees are gitignored and materialized by `fetch:runtime`; installs to userData are atomic (tmp → manifest → rename, `.dsh-manifest.json` zod-validated; dirs without a valid manifest are invisible).

**Node executor priority** (`dsh-runtime/node-exec.ts`): system node first (ABI matches npm-built native modules) → Electron's embedded node with `--expose-internals` appended to args (DSH's cordis loader requires it for HMR init; without the flag the boot crashes). Verified: all native modules are napi-v9, PTY works under both runtimes.

**Notify bridge** (`notify-bridge/`): two downlink-only WebSockets (`/api/events.mux`, `/api/events.host`) with an explicit same-origin `Origin` header to pass DSH's trust fence. **Never send any frame** — client frames make the server close 1008. Fail-soft by design: two-level loose zod (envelope shape, then narrow only the 4 payload types we care about: `approval/requested`, `approval/resolved`, `host/session-status`, `host/agent-error`); unknown frames are ignored and counted. Dedup handles the mux stream's reconnect-replay of pending approvals (approvalId LRU). Turn completion is signaled by `host/session-status` running true→false, not by parsing `turn/end`.

**Windows specifics**: `npm.cmd` cannot be spawned directly — `npm-runner.ts` resolves `npm-cli.js` and runs it via `ELECTRON_RUN_AS_NODE`. PATH lookups use platform specs (`;`/`node.exe`/`npm.cmd` vs `:`/`node`/`npm`). Tray uses colored PNGs on Windows, template images on macOS; `app.setAppUserModelId` is set on win32 for toasts.

## Hard-won facts (do not regress)

- `ws` package message callback signature is `(data: RawData, isBinary)` — NOT the browser `event.data`. Confusing them crashed the shipped app (has a regression test).
- The main window must `loadURL('http://127.0.0.1:<port>')`, never `loadFile` — DSH's fence rejects `Origin: null`.
- External SIGTERM/SIGINT/SIGHUP do **not** trigger Electron's `before-quit` — `main.ts` routes them into the same graceful-quit sequence or the DSH child leaks.
- `ShellSettings.flags` must stay `shellFlagsSchema.default(...)` — a missing-key zod default, so old `settings.json` files pass validation instead of being quarantined.
- Global `uncaughtException`/`unhandledRejection` handlers in `main.ts` log-and-keep-alive (also suppresses the Electron crash dialog); a dead shell would orphan the DSH child.

## Conventions

- No `console.*` anywhere — everything through `getLogger(scope)` (`src/main/logger.ts`, electron-log + in-memory ring for the Manage → Logs view). Non-Electron (vitest) environments are detected and skip electron-log transports.
- Immutability throughout: shared types are `readonly` to the leaves, settings objects are deep-frozen, updates go through pure merge functions. IO wrapper classes keep mutation strictly private.
- All boundary input is zod-validated: every IPC channel has a schema in `src/shared/ipc-schemas.ts` (single table registered in `ipc/register.ts`, which wraps handlers with validation and `Result<T>`).
- Settings writes are atomic (tmp + rename); a corrupt file is renamed `.bak-*` and defaults load — never crash.
- Commit messages: conventional commits (`feat:`, `fix:`…); attribution footer disabled per user's global config.
- Process-name matching on this machine: the dev Electron binary lives under `.pnpm/electron@…/node_modules/electron/dist/` (pnpm store path) — use that pattern for pgrep/pkill, not `node_modules/electron/dist`.

## Debugging on this machine

Shell log: `~/Library/Logs/dsh-gui/main.log`. DSH installs: `~/Library/Application Support/dsh-gui/versions/`. Smoke-test DSH behavior without the GUI: `fixtures/fake-dsh-server.mjs` (`DSH_FAKE_MODE=ok|silent|die-fast|crash-after-ready`). The DSH source clone used for protocol verification lives at `/tmp/dsh-research/deepseek-harness` (re-clone shallow if wiped).
