# 03 — Tech Stack & Program Choices

## Summary table

| Layer | Choice | Version target |
|---|---|---|
| Language | **TypeScript everywhere** (main + renderer + shared) | TS 5.x, `strict: true` |
| Desktop shell | **Electron** | 33+ (current stable at scaffold time) |
| Build tooling | **electron-vite** (Vite for renderer + bundling main/preload) | latest |
| UI framework | **React** | 18/19 |
| UI styling | Plain CSS (custom properties, dark theme) — no framework | — |
| State | **Zustand** (small, no boilerplate) | latest |
| IPC | **Hand-rolled typed preload API** (`contextBridge` + shared `api.d.ts`) — decision locked | — |
| Video probe/render | **FFmpeg/FFprobe as child processes** — hand-rolled typed arg builder (NOT fluent-ffmpeg; it is unmaintained) | ffmpeg 6+ (system has 8.0) |
| FFmpeg binaries | `ffmpeg-static` + `ffprobe-static` npm packages bundled as fallback; prefer system PATH ffmpeg when present | — |
| Text/graphics overlay | **@napi-rs/canvas** (prebuilt native bindings, no compiler needed on Windows — this is why NOT node-canvas) | latest |
| Text metrics (shared) | **opentype.js** — glyph advances + kerning parsed from the bundled TTFs, pure JS (runs identically in Node, Chromium, Vitest) | latest |
| Fonts | Bundled TTFs: **Inter** (400/600/800) + **Poppins** (SemiBold) — both SIL OFL licensed | — |
| Testing | **Vitest** (unit: layout engine, arg builder, template validation) | — |
| Packaging | **electron-builder** → NSIS installer + portable `.exe` | — |
| Lint/format | ESLint (typescript-eslint) + Prettier | — |

## Language choice: TypeScript

One language across UI, main process, and — critically — the **shared Layout Engine**. The layout math that positions text in the live preview is the *same compiled code* that positions text in the exported overlay PNG. A second language (Python/Rust) would force re-implementing layout twice and guarantee preview/export drift.

## Desktop shell choice: Electron (vs alternatives)

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Electron** | Pure JS; huge ecosystem; native dialogs, file drag&drop, taskbar progress; electron-builder makes Windows installers trivial; quick iteration with Vite HMR | ~90–150 MB installed; ~150–250 MB RAM idle | **Chosen.** Disk/RAM cost is irrelevant for a personal desktop tool; dev speed and preview-fidelity architecture win. |
| **Tauri 2** | ~10 MB binary; uses system WebView2 (present on Win10/11); Rust core is fast | Rust toolchain + learning curve; FFmpeg must be shipped as a "sidecar" binary anyway; smaller ecosystem for desktop-video tooling | Runner-up. Revisit only if bundle size ever matters. The architecture in `02-architecture.md` ports to Tauri unchanged except IPC. |
| **Local web app** (Vite + Node/Express + browser tab) | No Electron knowledge needed | Two processes; port management; no native file dialogs; worse drag&drop; no "app" feel | Rejected |
| **Python + PySide6 + MoviePy/ffmpeg** | Scriptable; ffmpeg bindings familiar | Weak/ugly UI tooling for a WYSIWYG editor; MoviePy is slow (pipes through Python); two-language layout problem | Rejected |
| **Pure CLI** (Node script) | Fastest to build; template render in ~1 day | No preview, no WYSIWYG, hook text positioning blind → defeats the product goal | Rejected for the product, **but** M1 is built as exactly this CLI core first (see roadmap) — the GUI wraps it. |

## Renderer / editor: React + plain CSS

- React because the editor screen is a natural component tree (template picker / preview / field panel), and live-updating preview from form state is React's bread and butter.
- **No component library (MUI/Antd)** for v1: the UI is 3 screens; a bespoke dark theme with CSS custom properties is lighter and looks like a video tool, not an admin panel.
- Zustand over Redux: one store (`useProjectStore`), a couple slices (project, renderJobs, settings). No ceremony.

## Video processing: raw FFmpeg via child processes

- FFmpeg is non-negotiable as the render engine — it is what CapCut-class tools use under the hood anyway, it is deterministic, and **version 8.0 (gyan full build) is already installed on this machine**.
- **No fluent-ffmpeg**: last publish years ago, API gaps for complex filtergraphs, hides arg construction behind a wrapper. Instead write a small **typed command builder** (~200 lines) that produces `string[]` argv arrays. This is unit-testable by snapshotting argv (see `technical/render-pipeline.md`).
- Binaries resolution order: 1) system PATH `ffmpeg` (if ≥ 6), 2) bundled `ffmpeg-static`. Rationale: gyan full builds include filters/encoders some static builds trim (e.g., some `drawtext` font backends, `subtitles` filter for phase 2 captions).
- Hardware encoders detected at startup: `h264_nvenc` (NVIDIA), `h264_amf` (AMD), `h264_qsv` (Intel). Setting defaults to `libx264 CRF 18` (deterministic, best compatibility); user can switch to NVENC with quality preset for 3–5× speed.

## Text rendering: opentype.js (measure) + `@napi-rs/canvas` (draw) + bundled TTFs

Two distinct jobs, deliberately split (audit Bug 3):

- **Measurement (shared, pure):** line breaking and shrink-to-fit need glyph advance widths. **opentype.js** parses the bundled TTFs in pure JavaScript, so the same metrics module runs in the sandboxed renderer, the Node main process, and Vitest — wrapping decisions are bit-identical everywhere. Column-count heuristics (`string-width`) are explicitly banned (wrong for proportional fonts), and native canvas measurement can't be used here because it doesn't run in `src/shared` or the browser sandbox.
- **Drawing (main, native):** text in the exported video is burned in as **transparent PNG overlays**, not `drawtext`:
  1. `drawtext` on Windows depends on fontconfig, which misbehaves with system fonts and per-user font installs.
  2. The canvas draws the **pre-broken lines** from the shared metrics — neither Skia nor the DOM ever re-wraps, so rasterizer differences can't change layout.
  3. Multi-line wrapped, auto-shrunk, emoji-capable text is trivial on canvas and painful in drawtext.
- `@napi-rs/canvas` over `node-canvas`: prebuilt N-API binaries for Windows (node-canvas needs node-gyp + native toolchain for many Electron/Node version combos — classic Windows pain).
- Fonts registered at app start via `GlobalFonts.registerFromPath` (`resources/fonts/*.ttf`); the same files are loaded as ArrayBuffers for opentype.js in each process.
- Emoji (if a text slot enables them): fall back to `twemoji`-style PNG substitution or a color-emoji-capable font — phase 2 detail, noted in `technical/future-extensions.md`.

## Package management & tooling

- **pnpm** as package manager (fast, disk-efficient; npm works too).
- `electron-vite` scaffolds main/preload/renderer with HMR for the React UI — this is the standard modern Electron setup and avoids hand-rolled webpack.
- electron-builder config targets NSIS (`x64`) + portable target. Portable mode flips data dir to `.\data` (see `technical/data-storage.md`).

## Testing strategy

| Layer | What | How |
|---|---|---|
| Layout Engine | Given template + inputs → exact geometry, line breaks, shrink-to-fit | Vitest pure unit tests |
| Arg builder | Given ResolvedLayout + settings → exact ffmpeg argv | Vitest, argv snapshot per template & feature matrix (trim, mute, blur bg, hw encoders) |
| Template validation | Malformed JSON cases | Vitest |
| Overlay Renderer | PNG output | Golden-file pixel-diff (pixelmatch) — catches font/DPI regressions |
| E2E (later, M2+) | Drop file → export → file exists & ffprobe asserts 1080×1920 | Playwright + Electron, only the happy path + cancel path |

No CI infrastructure in v0.1 (personal project, local `pnpm test` gate). GitHub Actions can be added when the repo goes to a remote.

## Dependency policy

Every dependency must earn its place; target **≤ 15 runtime deps**. Everything video-related is delegated to FFmpeg processes, so the JS surface stays small and auditable. No network-capable dependency is allowed (enforced by review; `electron` itself is the only one with net access, unused).

## Decided at planning time (formerly "open items")

1. IPC: **hand-rolled typed bridge — locked.** ~13 methods don't justify electron-trpc's dependency weight and major-version churn (simplicity audit).
2. Output filename pattern default: `{name}_{yyyyMMdd}_{HHmm}` (settings-editable).
3. Safe-zone overlay: **SVG drawn in-app**.
