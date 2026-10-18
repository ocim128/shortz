# ShortZ — Fast TikTok Video Editor (Plan)

**Working title:** ShortZ
**Status:** Planning (nothing implemented yet) — **Rev 3**: second audit applied (bounded video target box for all aspect ratios, `alphamerge` mask dimensions, ASAR font/template unpacking, knob naming + diagram cleanups). Rev 2: external audit applied (filtergraph robustness, `media://` preview protocol, shared opentype.js text metrics, Windows process/file hardening, template geometry & knob model fixes, scope cuts)
**Target platform:** Windows desktop (local app, no cloud, no accounts)

## What is ShortZ?

A small desktop app that turns a raw clip into a ready-to-post TikTok video in about a minute.

You drop in a video (usually a boring 16:9 landscape clip), pick a **template**, type a hook text, check the live preview, and hit **Export**. The app renders a 1080×1920 MP4 with FFmpeg and shows you the file. You post it to TikTok.

The core idea: **templates, not timelines**. We are not building another CapCut. We are building a fast, deterministic, one-screen transform: `raw clip + template + text → finished vertical video`.

## Example — Template 1 "Hook Letterbox" (the first template)

| Before (raw clip) | After (ShortZ export) |
|---|---|
| Landscape 16:9 clip (e.g. squirrel + microphone footage) | 1080×1920 portrait, black canvas |
| No text, no framing | Clip letterboxed in the upper-middle |
| Not postable on TikTok | Bold hook caption above the clip: *"A wildlife photographer put a microphone beside a baby squirrel. These are its actual eating sounds."* |

## Core decisions (short version)

| Decision | Choice | Why |
|---|---|---|
| App type | Local desktop app (Electron + React + TypeScript) | Pure JS speed of development, bundles its own FFmpeg, works offline on the user's Windows PC |
| Render engine | FFmpeg (spawned as child process) | Deterministic, fast, already the industry standard; FFmpeg 8.0 is already installed on this machine |
| Text rendering | Measured with **opentype.js** (pure TS, shared by preview & render), drawn to transparent PNG via `@napi-rs/canvas`, composited by FFmpeg | Identical line breaks in Node/Chromium/tests; no fontconfig/drawtext pain on Windows |
| Preview media | Privileged `media://` protocol with HTTP Range (206) support | Chromium blocks `file://` from the app origin; Range support = instant scrubbing |
| Templates | Declarative JSON files with slots (video / text / image / shape) | New templates = new JSON, no code change |
| Storage | Local filesystem only (`%APPDATA%\shortz`, portable mode planned) | No backend, no accounts, nothing to host |
| Output | H.264 + AAC, 1080×1920, `yuv420p`, `+faststart` | Exactly what TikTok wants; small files, no re-encode artifacts |

## Document map

| Doc | What's inside |
|---|---|
| [01-goals.md](01-goals.md) | Problem, goals, non-goals, user stories, MVP definition |
| [02-architecture.md](02-architecture.md) | Whole system/infrastructure: components, data flow, process model, storage |
| [03-tech-stack.md](03-tech-stack.md) | Language & framework choices, alternatives compared, libraries |
| [04-templates.md](04-templates.md) | The template system + full spec of Template 1 (from the before/after screenshots) + future templates |
| [05-roadmap.md](05-roadmap.md) | Milestones M0 → M4 with tasks and done-criteria |

### Technical sub-documents (`technical/`)

| Doc | What's inside |
|---|---|
| [technical/template-schema.md](technical/template-schema.md) | Full JSON/TypeScript schema for templates + example |
| [technical/render-pipeline.md](technical/render-pipeline.md) | Probe → overlay PNG → FFmpeg command construction, exact commands, progress/cancel |
| [technical/ui-spec.md](technical/ui-spec.md) | Screens, layout, components, interactions, shortcuts |
| [technical/data-storage.md](technical/data-storage.md) | Project file format, folder layout, settings |
| [technical/export-spec.md](technical/export-spec.md) | TikTok output specs, safe zones, encoding settings |
| [technical/project-structure.md](technical/project-structure.md) | Repo layout, dev setup, conventions |
| [technical/future-extensions.md](technical/future-extensions.md) | Auto-captions (Whisper), batch mode, direct upload, and other phase-2+ ideas |

## Reading order

1. `01-goals.md` — what we are building and (importantly) what we are NOT building.
2. `04-templates.md` — the heart of the product; read the Template 1 spec.
3. `02-architecture.md` + `03-tech-stack.md` — how it is built.
4. `05-roadmap.md` — in what order.
5. `technical/*` — when implementation starts.
