# Technical — Render Pipeline

From "user clicked Export" to "finished MP4 on disk". All pipeline logic lives in **`src/core`** (Node-only, Electron-free) so it runs identically from the M1 CLI and the M2 GUI; the Electron main process is only a thin IPC shell around it.

## Stage overview

```
1. PROBE      ffprobe source → ClipMeta (cached, rotation-normalized)
2. RESOLVE    Layout Engine: template + values + ClipMeta → ResolvedLayout
3. OVERLAY    draw text/masks → overlay.png (1080×1920, alpha) via @napi-rs/canvas
4. BUILD      arg builder → ffmpeg argv (string[])
5. RUN        spawn ffmpeg, parse -progress, report %, cancellable
6. FINALIZE   move temp → output path, update project history
```

## Stage 1 — Probe

```
ffprobe -v error -print_format json -show_format -show_streams <source>
```

Extract: `duration`, coded `width`/`height`, `r_frame_rate` (→ fps; keep 30000/1001 rational until CFR normalize), video codec, audio presence, channel count/layout, bitrate.

**Rotation normalization (normative — audit Bug 5):**
- Parse `side_data_list[].rotation` (and legacy `tags.rotate`).
- `ClipMeta` stores **display** dimensions: swap W/H when rotation ∈ {90, 270, -90, -270}. A portrait phone recording coded 1920×1080+rotate must report 1080×1920 to the Layout Engine, or letterboxing math treats it as landscape and distorts.
- Modern FFmpeg auto-applies rotation on decode, so filter chains see display orientation — the probe normalization exists to keep layout math consistent with what the filters receive. Preview (`<video>`) auto-rotates in Chromium for the same reason.

Cache key: absolute path + file size + mtime.

## Stage 2 — Resolve

Pure function (see `technical/template-schema.md`). Produces absolute geometry after rotation correction: video display box, final text line breaks/sizes, anchor-resolved text positions (`aboveVideo` slots: bottom edge = `video.y − gap`, top clamped ≥ `minY`). All boxes even-rounded (607.5 → 608). Non-fatal issues (safe-zone ink, shrink floor reached) come back as `warnings[]` for the UI.

## Stage 3 — Overlay PNG

`@napi-rs/canvas`, canvas 1080×1920, transparent background. Draws **lines computed by the shared metrics module** (opentype.js — identical in Node/Chromium/Vitest), so wrapping decisions are made once, upstream of any rasterizer:

1. **Text slots** — `fillText` per pre-broken line with `textAlign` set; fonts registered at startup (`GlobalFonts.registerFromPath(resources/fonts/…)`).
2. **Rounded corners, solid background (primary mechanism):** draw four background-colored corner covers onto `overlay.png`. Zero extra filters, immune to stream-termination/alpha edge cases.
3. **Rounded corners, non-solid background (blur):** needs real alpha → separate gray `mask.png` + the `alphamerge` chain in Case B2 below.
4. Phase 2: shape/image slots.

Static slots → one overlay.png for the whole duration.

## Stage 4 — FFmpeg argument construction

Hand-rolled typed builder producing `string[]` (never a shell string — paths with spaces are safe by construction on Windows).

### Robustness rules (normative — audit Bug 1)

1. **Every still-image input gets `-loop 1 -framerate 30`.** A bare PNG is a single-frame stream; whether it persists over the video depends on `overlay`'s `eof_action` defaults, and any `shortest=1` on that overlay terminates output at frame 0. `-loop 1` makes the stream infinite so duration is governed by the video alone — no semantics to reason about.
2. **Every generated source (`color`) gets an explicit `d=<duration>`** — otherwise it is infinite.
3. **Every overlay whose main stream must set output duration carries `shortest=1`.**
4. **Graph ends with `format=yuv420p`** (encoder-safe pixel format).
5. **Audio (audit Bug 6):** when kept → `-c:a aac -b:a 192k -ac 2 -ar 48000`. The explicit stereo downmix preserves 5.1 center-dialogue on phone speakers. Absent audio never errors: `-map 0:a?`; muted projects pass `-an` and drop the audio flags entirely.
6. **`-nostdin` always** (spawned-process hygiene).
7. Input trim via `-ss <start> -t <duration>` **before** `-i`; `fps=30` on `[0:v]` normalizes VFR → CFR.

### Case A — solid background, no alpha mask (baseline / corners-as-covers)

```bash
ffmpeg -y -nostdin -hide_banner -loglevel error \
  -ss <start> -t <duration> -i "<source>" \
  -loop 1 -framerate 30 -i "<overlayPng>" \
  -filter_complex "\
    [0:v]fps=30,scale=1080:608:flags=lanczos,setsar=1[vid]; \
    color=c=black:s=1080x1920:r=30:d=<duration>[bg]; \
    [bg][vid]overlay=0:520:shortest=1[base]; \
    [base][1:v]overlay=0:0:shortest=1,format=yuv420p[outv]" \
  -map "[outv]" -map 0:a? \
  -c:v libx264 -crf 18 -preset veryfast \
  -c:a aac -b:a 192k -ac 2 -ar 48000 -movflags +faststart \
  "<output>.mp4"
```

### Case B2 — blurred background + alpha-rounded corners (mask.png)

```bash
ffmpeg -y -nostdin -hide_banner -loglevel error \
  -ss <start> -t <duration> -i "<source>" \
  -loop 1 -framerate 30 -i "<overlayPng>" \
  -loop 1 -framerate 30 -i "<maskPng>" \
  -filter_complex "\
    [0:v]fps=30,split=2[src][sbg]; \
    [sbg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,gblur=sigma=30,eq=brightness=-0.05[bg]; \
    [src]scale=1080:608:flags=lanczos,setsar=1[vid]; \
    [2:v]format=gray[mask]; \
    [vid][mask]alphamerge[vidrounded]; \
    [bg][vidrounded]overlay=0:520:shortest=1[base]; \
    [base][1:v]overlay=0:0:shortest=1,format=yuv420p[outv]" \
  -map "[outv]" -map 0:a? \
  -c:v libx264 -crf 18 -preset veryfast \
  -c:a aac -b:a 192k -ac 2 -ar 48000 -movflags +faststart \
  "<output>.mp4"
```

`mask.png` = white rounded rect on black (canvas-drawn, same rect/radius as preview). `alphamerge` takes the mask stream's luma as the alpha for the video (FFmpeg's documented watermark pattern); `-loop 1` keeps the mask stream alive for the whole duration.

### Case C — blurred background, no rounding

Same as B2 minus the mask input and `alphamerge` line (`[bg][vid]overlay=…`).

### Case D — trim / mute deltas

- Trim: already expressed by `-ss/-t` in every case above.
- Mute: drop `-map 0:a?` and all `-c:a/-b:a/-ac/-ar` flags, add `-an`.

### Encoder variants

| Setting | libx264 (default) | NVENC |
|---|---|---|
| args | `-c:v libx264 -crf 18 -preset veryfast` | `-c:v h264_nvenc -rc vbr -cq 19 -preset p5` |
| notes | deterministic, universal | 3–5× faster; auto-detected, opt-in in settings |

Pixel format is fixed by the graph's `format=yuv420p` — do not also pass `-pix_fmt` (one mechanism, not two).

## Stage 5 — Execution (Windows-hardened — audit Bug 4)

```
spawn(ffmpegPath, args, { stdio: ['ignore','pipe','pipe'], windowsHide: true })
```

Runner also appends `-progress pipe:1 -nostats`.

- Progress: parse `out_time_us=` → `pct = out_time / (trimDuration)`; throttle IPC events to 4/s.
- **Cancel:**
  1. Check `child.exitCode !== null` first — if it already finished, nothing to kill.
  2. `taskkill /PID <pid> /T /F` (kills the process tree; `child.kill()` is unreliable mid-filtergraph on Windows).
  3. **Treat `taskkill` exit code 128 ("process not found") as success** — the render may exit naturally milliseconds before the kill lands; 128 is not an error, and an unhandled rejection here crashes the orchestrator.
- **Temp cleanup:** Windows holds file handles 50–200 ms after process death — immediate `fs.rm` triggers EBUSY/EPERM. Cleanup runs `fs.rm(tmp, { recursive: true, force: true })` with retries at 150 ms / 300 ms / 600 ms (~1 s total); anything still locked is swept by the next startup pass anyway.
- **Stalled guard:** no progress line for 60 s and no exit → mark stalled, offer cancel in UI.
- Errors: capture stderr; non-zero exit surfaces last 30 lines verbatim (collapsible in dialog).

## Stage 6 — Finalize

1. Output renders to `%TEMP%\shortz\<jobId>\out.mp4`.
2. Move to final destination with **EPERM-retry rename** (Windows rename over an existing/open target can throw; retry 3× with backoff, then cross-drive fallback = copy + delete). Conflict with existing file → auto-suffix `_1` (or confirm-overwrite per settings).
3. Record `{ path, duration, size, createdAt, templateId }` into project history (atomic save — see `technical/data-storage.md`).
4. Cleanup temp dir per Stage 5 retry policy.

## Preview ↔ render parity checklist

| Aspect | Preview (DOM) | Render (FFmpeg/canvas) | Same source |
|---|---|---|---|
| Video box geometry | CSS from ResolvedLayout | filtergraph from ResolvedLayout | ✅ same object |
| Text lines/size/wrap | per-line spans from ResolvedLayout | canvas fillText from ResolvedLayout | ✅ (opentype.js metrics) |
| Font files | `@font-face` from `resources/fonts/*.ttf` | `GlobalFonts.registerFromPath` same files | ✅ |
| Rounded corners | CSS border-radius | canvas corner-covers / mask | ✅ same rect+radius |
| Letterboxing | object-fit: contain | scale lanczos + overlay | visual-equivalent |
| Residual risk | rasterizer differences DOM vs canvas — mitigated by pre-broken lines (neither side re-wraps) | | golden-frame pixel-diff with tolerance |

## Test matrix (argv builder, unit-tested by snapshot)

`{trim, no-trim} × {mute, keep-audio} × {black, blur-bg} × {corners: none, covers, alphamerge} × {x264, nvenc}` = 48 argv fixtures, plus input-edge fixtures:

- unicode paths, spaces in paths, long path (>260 → `\\?\` prefix if needed)
- 4:3 source, already-9:16 source
- **phone clip with rotate metadata (portrait displayed)** — asserts layout used display dims
- VFR source — asserts `fps=30` present
- **no-audio source** — asserts no audio flags, exit 0
- **5.1 surround source** — asserts output `ac: 2`
