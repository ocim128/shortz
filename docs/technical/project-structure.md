# Technical — Project Structure & Dev Setup

## Repo layout

Monorepo-free single app (electron-vite convention):

```
shortz/
  docs/                          # ← this plan (keep updated with the code)
  package.json                   # single package, pnpm
  electron.vite.config.ts
  electron-builder.yml
  .eslintrc.cjs  .prettierrc
  tsconfig.json                  # strict; references below
  resources/
    fonts/
      Inter-Regular.ttf  Inter-SemiBold.ttf  Inter-ExtraBold.ttf
      Poppins-SemiBold.ttf      # + OFL.txt licenses
    templates/
      hook-letterbox.json        # built-in templates (shipped)
      thumb-hook-letterbox.png
    icons/                       # app icon set (ico/icns/png)
  fixtures/                      # test media (see fixture matrix at bottom)
  src/
    shared/                      # TIER 1 — pure TS: runs in Node, Chromium AND Vitest
      template/
        types.ts                 # Template/Slot/KnobDef types (schema doc)
        knob-registry.ts         # KnobId union + typed handlers' public surface
        validate.ts              # template JSON validation (incl. registry check)
      layout/
        engine.ts                # resolve(template, values, clipMeta) → ResolvedLayout
        text.ts                  # opentype.js word-wrap + shrink-to-fit (font data injected)
        geometry.ts              # rect math, even-rounding, safe-zone checks
    core/                        # TIER 2 — Node-only, ELECTRON-FREE
      ffmpeg/
        resolve-bin.ts           # system → bundled resolution + version check
        probe.ts                 # ffprobe wrapper + cache + rotation normalization
        argbuilder.ts            # ResolvedLayout + settings → argv (string[])
        runner.ts                # spawn, progress parse, taskkill(128-tolerant), rm-retry
      render/
        orchestrator.ts          # export job: stages 1–6
        overlay.ts               # @napi-rs/canvas draws lines from shared metrics
        fonts.ts                 # register TTFs at startup (fs-based loader for opentype too)
      store/
        fs-utils.ts              # atomic write (EPERM-retry), rm-retry
        projects.ts              # project CRUD, autosave
        settings.ts
        templates.ts             # registry: built-in + user dir, validation
    cli/
      index.ts                   # `pnpm cli render project.json` (tsx) — the M1 entry point
    main/                        # TIER 3 — Electron glue ONLY
      index.ts                   # app entry, single-instance lock, startup sweep
      ipc.ts                     # typed handlers; thin delegates into src/core
      protocol/
        media.ts                 # privileged media:// scheme, Range/206 streaming
      windows/                   # BrowserWindow creation, menu
    preload/
      index.ts                   # contextBridge.exposeInMainWorld('shortz', api)
      api.d.ts                   # THE shared IPC contract type (imported by renderer)
    renderer/
      index.html
      src/
        main.tsx  App.tsx
        stores/                  # zustand: project, render, settings
        screens/  Home/  Editor/
        components/              # PhonePreview, TemplatePicker, TrimRange…
        preview/
          apply-layout.ts        # ResolvedLayout → CSS/DOM (per-line spans)
          font-loader.ts         # fetch-based opentype loader for the renderer
        strings.ts  tokens.css
  tests/
    unit/                        # mirrors src/shared + core/argbuilder (vitest)
    golden/                      # rendered fixture frames + pixelmatch
```

## The purity tiers (the one architectural rule)

| Tier | Path | May import | Consumed by |
|---|---|---|---|
| 1 — pure | `src/shared` | nothing platform (no node:, no electron, no DOM-only APIs) | everything: renderer, core, cli, tests |
| 2 — node | `src/core` | Node builtins + npm (fs, child_process, @napi-rs/canvas, opentype.js) — **never `electron`** | main, cli |
| 3 — electron | `src/main`, `src/preload` | electron + core + shared | the app |

Why Tier 2 exists (audit C4 / Fix 6): **M1 is a CLI milestone.** `pnpm cli render project.json` must run the full probe → resolve → overlay → ffmpeg pipeline under plain Node (`tsx`) — no Electron module resolution, no `app.getPath`, no window. The GUI (M2) then wraps the *same* core; there is no second implementation to drift.

Tier 1 is what guarantees preview/export parity: layout + text metrics compile once and execute in Chromium (preview), Node (render), and Vitest.

## Local media for preview — the `media://` privileged protocol (audit Bug 2 / Fix 2)

Chromium will not load `file://` media from the app origin (`Not allowed to load local resource`), and HTML5 scrubbing needs HTTP Range (206) responses — a naive file protocol handler makes scrubbing restart from byte 0.

- Register a **privileged scheme** at app init:
  ```ts
  protocol.registerSchemesAsPrivileged([
    { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
  ]);
  ```
- `protocol.handle('media', …)` streams the file from disk and **answers `Range` requests** with `206` + `Content-Range` (full `200` when no header) so `<video>` seeks instantly.
- URLs look like `media://<percent-encoded absolute path>`; they are minted **only by the main process** (IPC `getMediaUrl`) — the renderer never constructs or sees raw `file://` paths.
- Drag & drop gives the renderer a path → it asks main for the URL; main validates the path exists and is a media file before minting.
- Dev mode works identically (the protocol is registered on the app session, independent of the Vite dev server origin).

## IPC contract (v1 — hand-rolled, locked; ~13 methods)

Decision locked per simplicity audit: `contextBridge` + typed `api.d.ts`. No electron-trpc — ~13 methods don't justify the dependency and its major-version churn.

```ts
interface ShortzApi {
  // projects
  createProject(sourcePath: string): Promise<Project>
  listProjects(): Promise<ProjectMeta[]>
  openProject(id: string): Promise<Project>
  saveProject(p: Project): Promise<void>          // also autosaved
  deleteProject(id: string): Promise<void>
  relinkSource(id: string, newPath: string): Promise<Project>
  // media
  pickFile(): Promise<string | null>              // native dialog
  getMediaUrl(sourcePath: string): Promise<string> // returns media:// URL (Range-capable)
  // templates
  listTemplates(): Promise<TemplateMeta[]>        // includes invalid ones w/ errors
  // render
  exportProject(p: Project, opts: ExportOptions): Promise<ExportResult>
  cancelExport(jobId: string): Promise<void>
  onRenderProgress(cb: (e: ProgressEvent) => void): Unsubscribe
  // shell
  revealInExplorer(path: string): Promise<void>
  openUserTemplatesFolder(): Promise<void>
  getSettings() / saveSettings(s)
}
```

Progress events over `webContents.send`; everything else request/response.

## Dev setup (Windows)

```powershell
# prerequisites: Node 20 LTS+, pnpm (corepack enable), git
# ffmpeg already on PATH on this machine (8.0) — none needed for dev
pnpm install
pnpm dev            # electron-vite: HMR renderer + main rebuild
pnpm cli render <project.json>   # M1 pipeline without any GUI (tsx)
pnpm test           # vitest unit + golden
pnpm lint
pnpm dist           # electron-builder → NSIS + portable in dist/
```

Scaffold source: `pnpm create @quick-start/electron` (electron-vite template, React + TS), then restructure into the tiers above.

## Conventions

- TypeScript `strict`, `noUncheckedIndexedAccess` on.
- No default exports (except entry points); named exports everywhere.
- Files: kebab-case; components: PascalCase files.
- Every user-visible string → `strings.ts`.
- Commits: conventional commits (`feat(editor): trim handles`).
- `docs/` is updated in the same PR/effort as behavior changes that affect it (this plan is the product memory).

## Fixture matrix (generate with FFmpeg into `fixtures/`, each < 1 MB)

| File | Purpose |
|---|---|
| `landscape_1080p_10s.mp4` | normal 16:9 + tone audio |
| `landscape_vfr.mp4` | variable frame rate (phone-style) — asserts `fps=` normalize |
| `portrait_rotated.mp4` | coded 1920×1080 **with rotate metadata** — asserts display-dim normalization |
| `square_4x3.avi` | odd container/aspect, **no audio** — asserts `-map 0:a?` / no audio flags |
| `surround_5_1.mp4` | 5.1 audio — asserts `-ac 2` downmix |
| `tiny_2s.mp4` | edge duration |
