# 05 — Roadmap

Milestones are strictly stacked: each one ends with something usable. Effort estimates assume solo development with AI assistance in the evenings (~1–2h/day).

## M0 — Scaffold (≈ 2–3 days)

**Goal:** empty but shippable app skeleton.

- [ ] Init repo: `pnpm create @quick-start/electron` (electron-vite) with React + TS strict.
- [ ] Set up `src/shared` (pure), `src/core` (Node-only, Electron-free), `src/main`, `src/preload`, `src/renderer` tier layout (see `technical/project-structure.md`).
- [ ] ESLint + Prettier + Vitest wired; `pnpm test` green with a smoke test.
- [ ] Dark theme base, app window (1280×800 min), native menu with About/Settings placeholders.
- [ ] FFmpeg resolver: system PATH → bundled static; log versions on startup.
- [ ] `ffprobe` wrapper + probe cache; unit tests with fixture files.

**Done when:** `pnpm dev` shows the window; a hidden test command probes a fixture MP4 and returns parsed JSON.

## M1 — Render core as CLI (≈ 4–6 days) ← *the heart, built GUI-less on purpose*

**Goal:** `pnpm cli render project.json -o out.mp4` (tsx, plain Node) produces the Template 1 output. All pipeline code lives in the Electron-free `src/core` tier — this milestone must run with no Electron module loaded (audit Fix 6).

- [ ] Template schema types + validator (`technical/template-schema.md`).
- [ ] Built-in Template 1 JSON ("Hook Letterbox").
- [ ] Layout Engine: resolve template + inputs → geometry (incl. `aboveVideo` anchoring); opentype.js word-wrap + shrink-to-fit in `src/shared`; unit tests.
- [ ] Overlay Renderer: `@napi-rs/canvas` → transparent PNG (text, rounded-corner mask).
- [ ] Arg builder: full FFmpeg argv from ResolvedLayout (matrix: trim × mute × background knob × encoder) with argv snapshot tests.
- [ ] Render runner: spawn, `-progress` parsing, cancel, temp cleanup.
- [ ] CLI entry: `render <project.json>`.
- [ ] Golden test: render fixture clip through Template 1 → ffprobe asserts 1080×1920/30fps/H264 → pixelmatch against golden PNG frame at t=2s.

**Done when:** acceptance tests A1–A5 from `01-goals.md` pass via the CLI (UI-free).

## M2 — Editor GUI (≈ 5–7 days)

**Goal:** the actual product loop (drop → template → text → preview → export).

- [ ] Home screen: new project (drag&drop file), recent projects, missing-source banner.
- [ ] Editor screen: template picker (cards + thumbnail), field panel (hook textarea, knobs), phone preview with live layout.
- [ ] `media://` privileged protocol with Range/206 streaming — preview playback of local files (audit Fix 2).
- [ ] Preview: `<video>` via `media://` + DOM overlay from ResolvedLayout; scrub bar; trim handles (start/end); audio keep/mute toggle.
- [ ] Safe-zone overlay toggle (SVG of TikTok chrome).
- [ ] Export flow: progress bar, cancel, done toast, "open output folder"; project autosave.
- [ ] Error surfaces: probe fail, ffmpeg fail (stderr tail), hook-too-long validation.

**Done when:** the full A1–A6 acceptance suite passes through the GUI; a friend can use it without instructions. → **v0.1 tag + portable exe built.**

## M3 — Comfort & quality (≈ 4–5 days)

**Goal:** make the 2-minute loop actually pleasant.

- [ ] Output filename patterns + remember last output dir.
- [ ] Hardware encoder auto-detect + settings page (encoder, CRF, output dir, ffmpeg source).
- [ ] Contingency only: preview proxy for heavy 4K sources — **build only if real-world scrubbing actually lags** (dropped from default scope by simplicity audit; original-file playback is the default).
- [ ] Template knob presets (save current knob set as a preset per template).
- [ ] Project history list of past exports with durations/sizes.
- [ ] Crash-safe temp sweep at startup; portable-mode flag.

**Done when:** 5 real videos produced end-to-end for actual posting; render settings stick between runs. → **v0.2.**

## M4 — Templates & captions (ongoing, ≈ 1–2 weeks)

**Goal:** breadth. In priority order:

- [ ] Template 2 "Blur Letterbox" (pure JSON — proves the extension story).
- [ ] Template 3 "Caption Below", Template 4 "Top/Bottom Bars".
- [ ] Auto-captions: faster-whisper/whisper.cpp transcription → timed text slots → ASS burn or timed PNGs (`technical/future-extensions.md`).
- [ ] Timed text engine: `tStart/tEnd` on slots with FFmpeg `enable=between(t,…)` + simple fade in/out.
- [ ] User-template hot reload + template validation panel.
- [x] Batch: shipped as the Batch screen — `path•hook` lines + a saved editor config, sequential queue in main (one ffmpeg at a time).
- [ ] Batch: multi-select projects in Home → queue renders overnight.

**Done when:** captioned story video produced start-to-finish in-app.

## Deferred / research parking lot

- Direct TikTok upload (Content Posting API — needs approved developer app; unreliable for personal accounts).
- Template 5 before/after split (multi-video engine work).
- AI hook suggestions (local LLM or user-provided API key — must stay opt-in to preserve the zero-unprompted-network default; the Downloader feature is the one built-in exception, see `twitter-downloader/01-goals.md` §G6′).
- macOS/Linux builds (electron-builder targets exist; demand first).

## Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| Preview ≠ export drift | Core promise broken | Layout Engine shared code + golden pixel tests in CI loop from M1 |
| `@napi-rs/canvas`/Electron ABI mismatch | Blocked build | Drawing-only dependency since Rev 2 (measurement is opentype.js, pure JS); verify in M0 spike; fallback: Playwright screenshot overlay (slower but identical rendering) |
| FFmpeg filtergraph edge cases (odd dims, VFR, 4:3 sources) | Render failures on real files | Clamp/normalize step in pipeline (scale to even dims, `fps` filter); fixture matrix tests with weird inputs |
| Scope creep toward "mini CapCut" | Never ships | Non-goals list in `01-goals.md` is the contract; every feature request must map to a template or knob, not to a timeline |
| Windows path/space quoting bugs | Broken renders for users with spaces in paths | Argv passed as arrays (no shell string), unit-tested with nasty paths |
