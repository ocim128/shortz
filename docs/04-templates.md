# 04 — Template System & Template 1

## What a template is

A template is a **declarative JSON description of a 1080×1920 composition**:

- a fixed canvas,
- **slots** — placeholders the user's content fills: video slots, text slots, (later) image/shape slots,
- default styling for each slot,
- **knobs** — small variations the UI exposes as toggles/sliders (background style, corner radius, text position).

The app resolves `template + user inputs + clip metadata` into absolute geometry (the Layout Engine), uses it for the live preview, draws non-video slots to a transparent PNG, and composites everything with FFmpeg. Full schema: `technical/template-schema.md`.

**Design principle — flexible, not pixel-pinned.** The screenshots define a *look*, not exact coordinates. Every template ships defaults that reproduce the look, plus knobs so the user can nudge things without editing JSON.

---

## Template 1 — "Hook Letterbox" (from the before/after screenshots)

### The transformation

| | Before (source clip) | After (export) |
|---|---|---|
| Aspect | Landscape 16:9 (e.g., 1920×1080 squirrel/microphone BTS footage) | Portrait 9:16, 1080×1920 |
| Canvas | — | Solid black background |
| Video | Full frame | Letterboxed: full clip width, centered horizontally, positioned in the **upper-middle** of the canvas |
| Text | None | **Hook** above the video: left-aligned, bold white, multi-line, e.g. *"A wildlife photographer put a microphone beside a baby squirrel. These are its actual eating sounds."* |
| Result | Not postable | Scrolling-feed-ready TikTok video |

Note: the TikTok chrome visible in the "after" screenshot (search pill at top, play button, right-side buttons) is **TikTok's own UI drawn over the video** — it is not rendered into the file. We only respect it via safe zones.

### Canvas

- Size: **1080 × 1920** (design space; all coordinates below are in these units).
- Background: solid `#000000` (knob: `#FFFFFF`, `#0F0F0F`, or blurred-scaled video).

### Slot: `video` (the clip)

- **Bounded target box: 1080 × 980 at y = 520** (bottom edge 1500 = canvas − bottom safe zone 420). **Fit mode: CONTAIN** (never crop) inside that box, centered — so *any* source aspect stays on-canvas (re-audit Issue 2):
  - 16:9 source → **1080 × 608** (607.5 rounded to even), letterboxed top/bottom.
  - Portrait 9:16 source → **551 × 980**, pillarboxed (black bars left/right), centered at x ≈ 264.
  - 4:3 source → **1080 × 810** (width-limited).
- Horizontal: content centered within the box; for 16:9 that means x = 0 full width.
- Vertical: `videoTop = 520` default (knob: 480–700) sets the box top; a 16:9 video bottom lands at ~1128, leaving the lower ~800px black — matches the screenshot's upper-middle placement.
- Corner radius: `24px` default (knob 0–48). Solid background → background-colored corner covers drawn on the overlay PNG; non-solid background → video-sized gray mask + `alphamerge` (see render doc).
- Scale filter: `lanczos` for downscaling quality.

### Slot: `hook` (the text)

- Position block: **anchored above the video** (`anchor: aboveVideo`, gap 32, minY 150), left-aligned like the screenshot.
  - `x = 48`, `width = 880` → box ends at **x = 928**, keeping wrapped ink clear of the right action rail (x ≥ 940) by construction.
  - Resolved box: bottom edge = `videoTop − 32`, top clamped ≥ 150 → with default `videoTop = 520` the block spans **y 150–488**, and the whole block **re-anchors automatically** when the `videoTop` knob moves the video — no fixed-y gap or overlap possible.
- Typography (defaults, all knobs):
  - Font: **Inter SemiBold** (registered TTF; knob: Poppins SemiBold).
  - Size: **68px**, shrink-to-fit down to 44px if the text is long.
  - Line height 1.25, max **4 lines**; color `#FFFFFF`; no stroke/shadow (screenshot look is clean flat white).
- Wrapping/shrink algorithm: break lines with canvas word-wrap at current size; if lines > 4 → decrease size by 2px and retry until ≤ 4 lines or 44px floor; if still > 4 lines at 44px → validation error in UI ("hook too long — trim it").
- Optional prefix emoji slot (e.g., 🎤) as a leading glyph in the same text run — phase 2 (emoji font).

### Knobs summary (UI-exposed variations of this template)

| Knob | Default | Range | Notes |
|---|---|---|---|
| `backgroundStyle` | `black` | black / white / darkGray / blurVideo | `blurVideo` = scaled-up blurred copy of the clip behind the letterbox (classic repost look) |
| `videoTop` | 520 | 480–700 px | Push video lower to fit longer hooks — the anchored hook text follows the video automatically |
| `videoCornerRadius` | 24 | 0–48 px | 0 = square corners like the screenshot |
| `textAlign` | left | left / center | Screenshot is left |
| `textFont` | Inter SemiBold | Inter / Poppins | |
| `textMaxLines` | 4 | 2–6 | |
| `videoScale` | 1.0 | 0.85–1.0 | Slightly inset video with visible margins (for white bg) |

### TikTok safe zones (all templates)

Reference regions on 1080×1920 to keep *critical content* out of (toggleable overlay in preview; stored per-template so templates can pre-avoid them):

| Region | Approx bounds | Why |
|---|---|---|
| Top bar | y < 150 | Status bar + "Find related content" search pill |
| Right rail | x > 940 (full height) | Like/comment/share/profile buttons |
| Bottom caption zone | y > 1500 | Username, caption, music ticker |

Template 1 already complies by construction: text ends ~y 490, video text-safe (video is full-bleed by design — that's fine, it's the content itself).

---

## Future templates (catalog ideas, priority order)

These reuse the exact same schema/engine; each is mostly a JSON file + thumbnail.

| # | Name | Concept | Adds to engine |
|---|---|---|---|
| 2 | **Blur Letterbox** | Same as T1 but `backgroundStyle=blurVideo` and rounded corners — the classic "repost" look | Nothing (knob promotion) |
| 3 | **Caption Below** | Video top ⅔, auto-shrunk caption strip below video (for clips with burned subs in frame) | Nothing |
| 4 | **Top/Bottom Bars** | Meme style: video center, white bars above+below with black Impact-ish text | New font bundle |
| 5 | **Before/After Split** | Two video slots stacked, "before/after" labels — for transformation content | Multi-video slots (engine change, phase 3) |
| 6 | **Subtitle Story** | 9:16 video full-bleed + auto-captions at bottom from Whisper transcription | Timed text slots (see future-extensions) |
| 7 | **Quote Card** | Static image + text (photo posts / slideshows) | Image slot type |

Promotion rule: a template idea becomes a milestone task only when the engine feature it needs already exists (or the idea is compelling enough to schedule the engine feature).

## Template authoring workflow (for the user's own templates)

1. Duplicate the closest built-in JSON into `%APPDATA%\shortz\templates\user\`.
2. Edit values (positions, colors, fonts, defaults). The schema doc lists every field.
3. Restart app (hot-reload of templates is a v0.2 nicety) → template appears in the picker with a "user" badge.
4. Validation errors show inline in the picker with the offending JSON path.
