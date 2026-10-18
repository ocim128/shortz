# Technical — Export Spec (TikTok-ready output)

Everything the renderer must guarantee about the final file.

## Container & streams

| Property | Value | Notes |
|---|---|---|
| Container | MP4 (`+faststart`) | moov atom at front — instant preview when uploaded / scrubbed |
| Video codec | H.264 High profile, `yuv420p` | TikTok re-encodes everything anyway, but H.264/yuv420p guarantees acceptance & no upload errors |
| Resolution | **1080 × 1920** | design space of every template |
| FPS | 30 (default) / 60 / source | normalize VFR → CFR via `fps` filter |
| Bitrate/quality | CRF 18 (libx264) ≈ 8–15 Mbps for typical clips | visually lossless at TikTok's re-encode |
| Audio | AAC-LC 192k, **forced stereo downmix `-ac 2 -ar 48000`** (if kept) | Explicit downmix preserves 5.1 center-dialogue on phone speakers; absent audio → `-map 0:a?` (no error); muted project → `-an` |
| Duration | ≤ 10 min hard; tool targets ≤ 3 min | TikTok limit; practically our clips are 10–60s |
| File size | ≤ 287.6 MB hard limit | a 60s CRF-18 1080p clip is ~40–80 MB — far under |

Pre-export validation (fail fast with clear message, before spawning ffmpeg):
- duration after trim ≤ 600s
- estimated size sanity (probe bitrate × duration) with warning if > 250 MB
- output dir writable (create + delete a test file)
- output filename free (or "overwrite?" confirm; default = auto-suffix `_1`)

## Safe zones (why layouts look like they do)

Regions TikTok's own UI covers when the video plays in the feed. Measured on 1080×1920 from the reference screenshot + community norms; stored per-template, shown as toggleable preview overlay. **These are guidance for text placement, not hard failures** — video content can flow under them.

| Zone | Rect (x, y, w, h) | Contents |
|---|---|---|
| Top bar | 0, 0, 1080, 150 | status bar + "Find related content" search pill |
| Right rail | 940, 0, 140, 1920 | like / comment / share / bookmark / avatar / spinning disc |
| Bottom caption | 0, 1500, 1080, 420 | username, caption, sound ticker |

Template 1 compliance: the hook box spans x 48–928 (width 880), so wrapped ink stays clear of the rail at x ≥ 940 by construction; the Layout Engine still raises a non-fatal warning if any rendered line's ink reaches x > 920 (e.g., after user knob edits on other templates).

## Filename convention

Default pattern `{name}_{yyyyMMdd}_{HHmm}` → `air-17oct2026_20261018_0935.mp4`. Tokens: `{name}` (project), `{template}`, `{date}`, `{time}`, `{seq}`. Sanitized (illegal Win chars → `_`), max 80 chars before extension.

## Post-export flow

1. Toast with duration/size + **Open folder** (Explorer, file pre-selected via `explorer /select,`).
3. Uploading stays manual in v1: TikTok web/mobile upload, pick file, add caption/sound there (native sound = better reach, and it's the reason `mute` knob exists).

## Verification protocol (manual, per release)

1. Export fixture clip through each built-in template.
2. `ffprobe out.mp4` asserts: `1080x1920`, `h264`, `yuv420p`, `aac`, fps as set, faststart (moov before mdat — check with `ffprobe -v trace 2>&1 | findstr moov` or a box-parser snippet).
3. Upload to a private TikTok account → plays full length, no quality warning, no "unsupported format".
4. Watch on phone: hook readable at arm's length (font ≥ 44px design space passed this test for Inter SemiBold), nothing critical under the caption zone.
