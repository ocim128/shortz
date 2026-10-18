# 02 — Architecture & Infrastructure

## Big picture

ShortZ is a **single local desktop app**. There is no server, no database, no cloud. Everything runs on the user's Windows PC.

```
┌─────────────────────────────────────────────────────────────────────┐
│                        ShortZ (Electron app)                        │
│                                                                     │
│  ┌─────────────────────── Renderer process ──────────────────────┐  │
│  │  React UI (Vite)                                              │  │
│  │  ├─ Home / project list                                       │  │
│  │  ├─ Editor screen                                             │  │
│  │  │   ├─ Template picker      ├─ Live preview (phone frame)    │  │
│  │  │   ├─ Field inputs         ├─ Safe-zone overlay toggle      │  │
│  │  │   └─ Trim / audio controls └─ Export bar + progress        │  │
│  └───────────────────────────────┬───────────────────────────────┘  │
│                                  │ IPC (typed hand-rolled bridge via preload)          │
│  ┌─────────────────────── Main process ─────────────────────────┐  │
│  │  ├─ Project Store        (load/save project.json)            │  │
│  │  ├─ Template Registry    (built-in + user JSON templates)    │  │
│  │  ├─ Ingest Service       (ffprobe → clip metadata, cached)   │  │
│  │  ├─ Layout Engine        (pure TS: template + inputs →       │  │
│  │  │                        absolute geometry for every element)│  │
│  │  ├─ Overlay Renderer     (@napi-rs/canvas → transparent PNG) │  │
│  │  ├─ Render Orchestrator  (builds FFmpeg args, spawn, parse   │  │
│  │  │                        -progress, cancel, temp cleanup)    │  │
│  │  └─ Output Manager        (filename pattern, reveal folder)  │  │
│  └───────────────────────┬─────────────────────────────────────┘  │
└──────────────────────────┼──────────────────────────────────────────┘
                           │ child processes
              ┌────────────┴────────────┐
              ▼                         ▼
        ffmpeg.exe                 ffprobe.exe
        (render + encode)          (metadata probe)
```

**Key rule:** the *Layout Engine* is pure TypeScript shared by renderer and main. The preview in the renderer and the PNG overlay burned into the video are computed from the **same layout function**, so preview matches export (goal G3).

## Components

### 1. Template Registry
- Loads built-in templates from `resources/templates/*.json` (app package) and user templates from the data folder (`templates/user/*.json`).
- Validates each against the schema (`technical/template-schema.md`); invalid templates are reported in the picker, not silently dropped.
- Exposes metadata for the picker: id, name, description, thumbnail, supported input aspect ratios.

### 2. Ingest Service
- On import: run `ffprobe -print_format json -show_format -show_streams` on the file.
- Extract: duration, width/height, fps, video codec, audio presence, bitrate.
- Cache probe results keyed by file path + size + mtime (re-probe only when changed).
- Also generate one thumbnail (frame at 10% of duration, scaled to ~360px wide) for the UI.

### 3. Layout Engine (pure, shared)
- Input: `Template` + `UserInputs` (hook text, toggles, knob values) + `ClipMeta`.
- Output: `ResolvedLayout` — every element with absolute px geometry in the 1080×1920 design space, final font sizes after shrink-to-fit, text line breaks.
- No DOM, no canvas, no Node APIs → unit-testable, runs identically in renderer (preview) and main (render).
- Text measurement uses **opentype.js** glyph-advance metrics (+ kerning) from the bundled TTFs — pure JS, so wrapping/shrink decisions are bit-identical in Chromium, Node, and Vitest. Font binaries are handed in through an injected `loadFont(key): ArrayBuffer` loader, keeping this module platform-free. Both the DOM preview and the canvas overlay renderer only ever consume these pre-broken lines (never re-wrap). `string-width`-style column metrics are banned — wrong for proportional fonts.

### 4. Preview Compositor (renderer)
- HTML/CSS composition inside a phone-shaped frame (1080×1920 design space scaled down ~0.36 → 390×693 on screen).
- `<video>` element plays the source through the privileged **`media://` protocol** (registered on the app session with `stream: true`): the handler streams the file from disk and answers HTTP `Range` requests with `206`/`Content-Range`, so seeking/scrubbing is instant. Direct `file://` playback is impossible — Chromium blocks it from the app origin, and naive handlers without Range break scrubbing. URLs are minted only by the main process (IPC `getMediaUrl`); the renderer never builds file paths into sources.
- Text/shape slots are absolutely-positioned DOM nodes styled from the `ResolvedLayout` (per-line spans; the browser never re-wraps).
- Safe-zone overlay is a static PNG/SVG of TikTok's UI chrome (search pill, action rail, caption area), toggleable.

### 5. Overlay Renderer (main)
- For text/image/shape slots: draw them onto one or more 1080×1920 transparent PNGs with `@napi-rs/canvas` — consuming the **pre-broken lines from the shared opentype metrics** (never re-measuring), with the bundled TTF fonts registered at startup.
- Static elements → single PNG for the whole duration.
- Timed elements (future: captions, fades) → per-time-range PNGs with FFmpeg `enable='between(t,…)'`.
- Video slots are NOT drawn here — FFmpeg handles video scaling/padding itself; the overlay PNG only carries graphics and text.

### 6. Render Orchestrator (main)
- Builds the FFmpeg argument list from `ResolvedLayout` + export settings (see `technical/render-pipeline.md` for the exact commands).
- Spawns `ffmpeg.exe` as a detached child process with `-progress pipe:1 -nostats`.
- Parses progress (frame/time → %), emits IPC events to the renderer.
- Cancel = `taskkill /T` on Windows (kills the process tree), then clean temp files.
- Temp workspace: `%TEMP%\shortz\<jobId>\`, always cleaned in a `finally` (and swept at app start for leftovers after crashes).

### 7. Project Store
- CRUD for projects as JSON files in the data folder (`technical/data-storage.md`).
- Holds: source path, template id + field values, trim, audio setting, output history.
- Autosave on change (debounced 500ms).

## Data flow — export

```
User clicks Export
   │
   ▼
Renderer sends IPC: render(projectId)
   │
   ▼
Main: load project → Layout Engine → ResolvedLayout
   │
   ├─▶ Overlay Renderer → overlay.png (transparent, 1080×1920)
   │
   ▼
Render Orchestrator builds args:
   ffmpeg -ss <trimStart> -to <trimEnd> -i source.mp4
          -i overlay.png
          -filter_complex "…scale/pad to canvas…; …overlay text…"
          -c:v libx264 -crf 18 … out.mp4
   │
   ▼
spawn ffmpeg → stream -progress → IPC → progress bar
   │
   ▼
on exit(0): move temp → final output path, record in project history,
            IPC → renderer shows "Done — Open folder"
```

## Process model & concurrency

- **One render job at a time** in v0.1 (queue in v0.2 if batch is added). A second click while busy = disabled button, not a queue.
- Renders run fully out-of-process; even if ffmpeg hangs, the UI stays responsive and the user can cancel.
- Probe/thumbnail jobs are also child processes but are fast; they run on demand with caching.
- Hardware encode: detect NVENC/AMF/QSV once at startup (`ffmpeg -hide_banner -encoders`), expose encoder choice in settings; default `libx264` for determinism.

## Preview performance

The preview plays the **original file directly** through `media://` — hardware-accelerated Chromium handles 10–60s 1080p repost clips effortlessly. **No proxy pipeline in v0.1** (simplicity audit: it pre-allocated caches, LRU pruning, and IPC surface for a problem 95% of clips don't have). Contingency only: if real-world 4K/high-bitrate scrubbing ever lags, generate a 540×960 proxy on first open and swap the `<video>` source; export always uses the original. Deferred, not scheduled.

## Storage & infrastructure (summary — details in `technical/data-storage.md`)

| Thing | Where |
|---|---|
| App data (projects, settings, caches) | `%APPDATA%\shortz\` (per-user), portable mode = `.\data\` if a `portable.flag` exists |
| Output videos | user-chosen, default `Videos\ShortZ\` |
| Built-in templates | inside the app package `resources/templates/` |
| User templates | `%APPDATA%\shortz\templates\user\` |
| Temp render workspace | `%TEMP%\shortz\<jobId>\` |
| FFmpeg / ffprobe | bundled via `ffmpeg-static` + `ffprobe-static`; if the system has FFmpeg on PATH (this machine has 8.0), prefer the system one (settings toggle) |

## Security posture

- **Zero network calls.** No update pings, no telemetry. (electron-builder updates can be enabled later, opt-in.)
- Electron: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` for the renderer; all FS/process access goes through a typed preload bridge with an allow-list (`openFile`, `probe`, `render`, `cancel`, `revealInExplorer`, …).
- The `media://` scheme is registered as **privileged** and its URLs are minted only by the main process after validating the path — the renderer cannot use it to read arbitrary files it wasn't handed.
- Source files are read only; ShortZ never writes to the input directory.

## Failure handling

| Failure | Behavior |
|---|---|
| Source file moved/deleted | Project opens with "re-link source" banner; probe re-runs on relink |
| Corrupt / unsupported input | ffprobe fails → friendly error with the raw stderr in a collapsible |
| ffmpeg exits non-zero | Show last 30 lines of stderr in the error dialog |
| App crash mid-render | Startup sweep deletes `%TEMP%\shortz\*` older than 24h |
| Disk full | ffmpeg error surfaced; temp cleaned |
| Output path unwritable | Pre-check write access before render starts |

## Why not a web app / server?

A local web app (React + Node server) would also work, but then there are two processes to start, a port to manage, and no native file dialogs / drag-drop of large files is clunkier. A desktop shell gives: single exe, native dialogs, taskbar progress, autostart friendliness. Since there is **no multi-user or remote requirement whatsoever**, desktop wins. (Comparison table in `03-tech-stack.md`.)
