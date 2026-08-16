# DSH GUI — Desktop App for DeepSeek Harness

A native desktop shell for [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) on **macOS (Apple Silicon)** and **Windows (x64)**, built with **Electron + 100% TypeScript**.

The shell is deliberately thin — it is a *process manager + browser container*. It never forks DSH, never copies its frontend, and never touches DSH internals, so it keeps working as DeepSeek ships rapid developer-preview releases: upgrading DSH is just installing another version inside the app.

> **Unofficial community project.** Not affiliated with or endorsed by DeepSeek. DSH itself is MIT-licensed — get it [here](https://github.com/deepseek-ai/deepseek-harness).

## Features

| | |
|---|---|
| **Bundled DSH runtime** | The installer ships with a complete DSH runtime — **zero downloads, zero Node.js/npm requirement** on the target machine. Falls back from system Node to Electron's embedded Node (`--expose-internals`) automatically. |
| **Official Web UI, embedded** | The app spawns DSH on a random loopback port and renders the official Web UI in a native window — every upstream UI update arrives for free. |
| **Version manager** | Install / pin / switch / remove any `@deepseek-ai/dsh` npm version side-by-side with the bundled one (bundled versions are read-only). |
| **DeepSeek API Key setting** | First-class API Key + Base URL fields (stored locally, injected when spawning DSH); a one-time dialog guides you on first launch. |
| **Tray + background** | Closing the window keeps sessions running in the background. Menu: open / manage / restart / stop backend / launch-at-login / quit. |
| **Native notifications** | Approval requests, task completion and agent errors — with per-category toggles and "only when hidden" mode. |
| **Crash resilience** | Exponential-backoff restarts (1s→60s, gives up after 5), 20s startup watchdog, graceful shutdown (SIGTERM→SIGKILL), global exception guard so the backend never becomes an orphan. |

## Download & Install

Grab the latest from [**Releases**](../../releases):

| File | Platform |
|---|---|
| `DSH-GUI-<version>-arm64.dmg` (~179 MB) | macOS, Apple Silicon (M1/M2/M3/M4) |
| `DSH-GUI-Setup-<version>-x64.exe` (~212 MB) | Windows 10/11 x64 |

### macOS

1. Open the `.dmg` and **drag DSH GUI into /Applications** (required — otherwise it won't appear in Launchpad).
2. First launch, unsigned app (one-time). Any of:
   - **Recommended (macOS 13/14/15):** double-click DSH GUI once so macOS blocks it, then open **System Settings → Privacy & Security**, scroll down to the *"DSH GUI was blocked"* notice → click **Open Anyway** → enter your password.
   - Right-click DSH GUI → **Open → Open**.
   - Terminal: `xattr -dr com.apple.quarantine /Applications/DSH\ GUI.app`.
3. The app auto-starts the bundled DSH and offers to set your **DeepSeek API Key** — the only required step.
4. If Launchpad doesn't refresh: `killall Dock`.

### Windows

1. Run the installer (NSIS: pick a directory, desktop + Start Menu shortcuts are created).
2. SmartScreen warning (unsigned): **More info → Run anyway**.
3. Same as macOS: auto-start + API key prompt.

## First run in 30 seconds

Install → open → the window shows the DSH Web UI → the app prompts for your DeepSeek API Key (**Manage → Settings**, stored only on your machine) → create a session and go. Model credentials can alternatively be configured inside DSH's own Models page (`~/.dsh`).

## Build from source

Requirements: Node ≥ 22.19 (DSH engines `^22.19 || >=24`), pnpm 10.

```bash
pnpm install            # if the Electron binary didn't download: node node_modules/electron/install.js
pnpm dev                # dev mode (HMR)
pnpm test               # vitest (incl. real-subprocess supervisor integration tests)
pnpm typecheck
pnpm icons              # regenerate app/tray icons (pure Node, zero image deps)
pnpm fetch:runtime      # materialize the bundled DSH tree into resources/ (skips if present)
pnpm dist               # macOS arm64 .dmg (self-contained, ~179 MB)
pnpm dist:win           # Windows x64 NSIS installer (cross-builds from macOS, ~212 MB)
```

Runtime locations (macOS notation; Windows uses `%APPDATA%`):

- Bundled DSH runtime: inside the app bundle `Resources/resources/dsh-runtime[-win]/`
- User-installed versions: `~/Library/Application Support/dsh-gui/versions/`
- Shell settings: `…/dsh-gui/settings.json` (atomic writes; corrupt files are quarantined, never crash the app)
- Logs: `~/Library/Logs/dsh-gui/main.log` (also visible in **Manage → Logs**)

## Architecture

```
Electron main (the shell's brain)
 ├─ runtime-supervisor ──spawn──▶ DSH child (node lib/bin.js web --port 0)
 │     └─ banner-parser → random port → host.describe probe
 ├─ notify-bridge ──ws──▶ /api/events.mux + /api/events.host (read-only, fail-soft)
 ├─ version-manager ──npm install --prefix──▶ userData/versions/<ver>/ (tmp→manifest→rename)
 ├─ settings store (atomic JSON) ├─ tray / auto-launch
 └─ IPC (zod-validated minimal channel surface)
Main window: local loading/error/setup page → after ready, loadURL = official DSH Web UI
Manage window (separate): versions / settings / logs
```

**All upstream coupling is confined to 4 files** — if a DSH release changes behavior, this is where adaptation happens:

| File | Coupling |
|---|---|
| `src/main/dsh-runtime/banner-parser.ts` | stdout readiness line `dsh web: http://127.0.0.1:<port>` (3-tier fallback) |
| `src/main/dsh-runtime/describe-probe.ts` | `POST /api/host.describe` envelope |
| spawn contract in `src/main/main.ts` | launch command convention |
| `src/main/notify-bridge/ws-frame-schemas.ts` | only 4 payload types are recognized (two-level loose zod; anything unknown is ignored and counted) |

### Platform notes

- The bundled runtime tree is materialized per platform: `resources/dsh-runtime/` (darwin-arm64) and `resources/dsh-runtime-win/` (win32-x64, cross-installed on macOS via `npm --os=win32 --cpu=x64 --ignore-scripts`; koffi/sharp/require-builtin ship official win32-x64 prebuilds and node-pty bundles ConPTY prebuilds for all platforms).
- Windows `npm.cmd` cannot be spawned directly — the runner resolves `npm-cli.js` and executes it via `ELECTRON_RUN_AS_NODE`.
- Tray icons: macOS template images (system-tinted) vs. colored PNGs on Windows; `app.setAppUserModelId` is set on Windows for toast notifications.

## Verification checklist (after a DSH upgrade)

1. `pnpm dev` → app starts, Web UI loads, no `TypeError`/`uncaughtException` in logs.
2. Send a message in a session → reply streams; run a tool that needs approval → native notification appears and focuses the window on click.
3. Close window → session keeps running; quit from tray → DSH child exits cleanly (code 0).
4. Manage → Versions: install a second version → switch → roll back; the bundled version can't be deleted.
5. `pnpm dist` → install the dmg/exe → repeat 1–3 on a clean machine.

## Troubleshooting

- **Not in Launchpad** (macOS): the app must live in /Applications; then `killall Dock`.
- **Backend stops repeatedly**: open **Manage → Logs**; the error page keeps the last 50 stdout/stderr lines.
- **No notifications**: check Manage → Settings toggles and "only when hidden"; on Windows the app must be installed (not run from the unpacked dir) for toasts.

## License

MIT — same as DSH itself. Each user obtains DSH from npm or via the bundled runtime; DeepSeek Harness is © DeepSeek.
