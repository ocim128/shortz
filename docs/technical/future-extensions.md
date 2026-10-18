# Technical — Future Extensions (phase 2+ designs)

Parking lot with enough design depth to be schedulable. Nothing here is in MVP; each section states the engine change it needs.

## 1. Auto-captions (Whisper) — the highest-value addition

**User story:** drop a talking clip → transcript appears as timed captions on the video → edit text → export. TikTok's native auto-captions are unreliable and can't be styled per-template.

### Pipeline

```
source ──▶ extract wav 16k mono (ffmpeg) ──▶ local STT ──▶ segments[] ──▶ editor review ──▶ timed text slots
```

### STT engine choice

| Option | Verdict |
|---|---|
| **whisper.cpp** (GGML models, CPU) | **Chosen for v1 of captions.** Single C++ binary/model files we can ship; runs well on CPU; `small`/`medium` models; word-level timestamps via token-level output (good enough). |
| faster-whisper (Python, CTranslate2) | Faster, but drags a Python runtime into an otherwise pure-TS app |
| OpenAI API / cloud STT | Rejected: breaks zero-network guarantee; optional opt-in later at most |

- Model download (75 MB–500 MB) is **user-opt-in on first use** with a clear "downloads a model file, no other network use" explanation. Models cached in `data/cache/models/`.
- `small.en` default for English content; language picker later.

### Engine changes

- `TextSlot` gains timing: many short-lived text instances from one logical slot. Schema: captions are a special `captionTrack` on the project, styled by a designated text slot; layout engine lays each segment out with the slot's style.
- Render: burn via **ASS subtitle file** (libass handles wrapping/timing/fades battle-tested) with styles generated from the slot — requires FFmpeg build with `subtitles` filter (gyan full has it; bundled static must be checked). Fallback: per-segment PNG overlays with `enable='between(t,a,b)'`.

### Editor UX

Transcribe button → progress → caption list (segment text editable, times nudgeable ±0.1s) synced with preview playhead. Profanity/typo fixes happen here before export.

## 2. Batch mode & watch folder

- Multi-select projects in Home → "Export all" → sequential job queue in main process (one ffmpeg at a time; NVENC makes overnight runs trivial).
- Watch folder mode: `settings.watchDirs[]` — new file appears → auto-create project with chosen default template → render → drop into output. Turns ShortZ into a repost pipeline appliance.
- Engine changes: job queue in orchestrator (already single-flight in v1, so mostly UI + persistence of queue state).

## 3. Background music & sound

- `assets/music/` folder user drops MP3s into; per-project music picker with volume mix (`amix` + `sidechaincompress` ducking under voice, both single ffmpeg filterchains).
- Loop/trim music to clip length (`aloop`, `-shortest`).
- No licensed content shipped — user's own files only (copyright posture stays clean).

## 4. Direct TikTok upload — deferred, likely permanently

TikTok Content Posting API requires: registered developer app, approved products, OAuth user tokens, and unstated review. For a personal tool this is more fragile than the manual upload, and native-sound posting (better reach) isn't possible via API anyway. Keep manual; revisit only if TikTok relaxes access.

## 5. More templates (engine features they unlock)

| Template | Engine need |
|---|---|
| Before/After split | multi-`VideoSlot` inputs (trim per slot, two sources) |
| Photo card / slideshow | `ImageSlot` + per-image duration |
| Animated hook (pop-in, highlight sweep) | keyframed text: canvas-rendered sprite sheet or ASS `\t()` animations; v2 design doc when scheduled |
| Progress bar overlay ("wait for it") | shape slot with width bound to `t/duration` — draws per-frame → needs `sendcmd`/`geq` or ASS; same v2 design |

## 6. AI hook suggestions — opt-in only

Local: too heavy. User-provided API key (stored in settings, never synced): a "suggest hook" button next to the textarea sending the transcript (from #1) + template context. Off by default; app remains zero-network unless the user flips it on. Guarded behind the same review as any network-capable dependency (dependency policy in `03-tech-stack.md`).

## 7. Analytics-lite (local)

Introduce the append-only global exports log (`exports.jsonl` — one line per render: timestamp, projectId, templateId, path, size, encoder; cut from v0.1 by simplicity audit) together with a Home dashboard: exports/week, template usage, average duration — pure local aggregation, no external events.

## 8. Cross-platform

electron-builder targets exist for macOS/Linux; blockers are font rendering parity tests (golden frames) and NVENC→videotoolbox/vaapi variants in the arg builder. Demand-driven; architecture has no Windows-only assumptions beyond `taskkill` (already isolated in `runner.ts` behind a `killProcess(pid)` interface).
