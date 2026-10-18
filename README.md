# ShortZ

A small local desktop app that turns a raw clip into a ready-to-post TikTok video in about a minute: drop a landscape video, pick a template, type a hook, export a 1080×1920 MP4. **Templates, not timelines** — no CapCut, no accounts, no cloud.

The complete, audited plan (architecture, template schema, render pipeline, UI spec) lives in **[docs/README.md](docs/README.md)** — that is the real documentation; this file is only the dev quickstart.

## Dev quickstart (Windows)

```powershell
pnpm install
pnpm dev          # Electron app with HMR (dark shell: Home + Editor)
pnpm test:ui      # UI end-to-end suite (spawns its own pnpm dev via CDP)
pnpm test         # engine unit/integration suites (vitest)
pnpm typecheck    # tsc across all tier configs
pnpm dist         # NSIS installer + portable exe into dist/
```

Notes:

- `pnpm dist` on a machine without symlink privileges (no Developer Mode/admin) needs the winCodeSign cache pre-populated once — see `tmp/NOTES-B.md` §packaging.
- Portable mode: drop a `portable.flag` file next to `ShortZ.exe` → data moves to `.\data\` next to the exe instead of `%APPDATA%\shortz`.
- The E2E suite kills running `electron.exe`/`ShortZ.exe` instances first — dev and packaged builds share the single-instance lock.

**Status:** engine in progress — UI shell functional with mocked engine IPC (drop → preview → trim all real; export pending the render core).
