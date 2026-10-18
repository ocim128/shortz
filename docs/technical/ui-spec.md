# Technical — UI Specification

Dark-themed, three screens total. Density over decoration — this is a tool, not a feed.

## Design tokens

```css
--bg-0: #0d0d0f;   /* app background        */
--bg-1: #16161a;   /* panels                */
--bg-2: #1f1f25;   /* inputs, cards         */
--fg-0: #f2f2f4;   /* primary text          */
--fg-1: #9a9aa6;   /* secondary text        */
--accent: #fe2c55; /* TikTok-ish red-pink   */
--ok: #2bd576; --err: #ff5252;
font-family: Inter, system-ui; base size 14px;
```

## Screen 1 — Home

```
┌────────────────────────────────────────────────────────────┐
│  ShortZ                                        [Settings]  │
│                                                            │
│  ┌──────────────── Drop a video here ────────────────┐     │
│  │            (or click to browse)                   │     │
│  └───────────────────────────────────────────────────┘     │
│                                                            │
│  Recent projects                                           │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                   │
│  │ ▶ thumb  │ │ ▶ thumb  │ │ ▶ thumb  │   card: source    │
│  │ air-17…  │ │ fox-cli… │ │ gym-com… │   name, template, │
│  │ T1 · 2h  │ │ T2 · 1d  │ │ T1 · 3d  │   last edited     │
│  └──────────┘ └──────────┘ └──────────┘                   │
└────────────────────────────────────────────────────────────┘
```

- Drag&drop anywhere on the window → creates project → jumps to Editor.
- Missing source → card shows orange ⚠ "re-link" state; click → file picker.
- Card context menu: duplicate, open project file location, delete (with confirm).

## Screen 2 — Editor (the product)

```
┌──────────────────────────────────────────────────────────────────────────┐
│ ← Back   air-17oct2026.mp4 · 1920×1080 · 30fps · 0:27        [Export ▶] │
├────────────┬──────────────────────────────────────┬──────────────────────┤
│ TEMPLATES  │  PREVIEW (phone frame)               │  TEMPLATE SETTINGS   │
│            │  ┌────────────────┐                  │                      │
│ ┌────────┐ │  │  ▄▄ search ▄▄  │ ←safe-zone UI    │  Hook text           │
│ │▓▓ T1   │ │  │                │  (toggle)        │  ┌────────────────┐  │
│ │ active │ │  │  Hook text     │                  │  │ textarea       │  │
│ └────────┘ │  │  wraps here    │                  │  └────────────────┘  │
│ ┌────────┐ │  │                │                  │  ⚠ 4 lines max        │
│ │▓▓ T2   │ │  │ ▄▄▄▄▄▄▄▄▄▄▄▄ │                  │                      │
│ └────────┘ │  │ ▌   video    ▐ │                  │  Background  [Black▾]│
│ ┌────────┐ │  │ ▀▀▀▀▀▀▀▀▀▀▀▀ │                  │  Video pos  ──●──     │
│ │＋ user │ │  │                │                  │  Corners    ──●──     │
│ └────────┘ │  │  (black)       │                  │  Text align [Left▾]  │
│            │  └────────────────┘                  │                      │
│            │  ▶ ──────────●───── 0:04 / 0:27      │  ── CLIP ──          │
│            │  [3.2s]────▲━━━━━━▲─[21.0s]          │  Audio (•) keep ( ) mute │
├────────────┴──────────────────────────────────────┴──────────────────────┤
│  Rendering… ████████████░░░░░ 63% · eta 8s                    [Cancel]  │ ← only while busy
└──────────────────────────────────────────────────────────────────────────┘
```

### Regions

**Left — template picker**
- Cards: thumbnail (rendered mini mockup or static asset) + name; built-in badge vs `user` badge.
- Invalid user templates listed greyed with ⚠ tooltip showing the JSON validation error path.
- `＋ user` card opens the user-templates folder in Explorer.

**Center — preview**
- Phone frame ~390×693 (scale 0.36 of 1080×1920), letterboxed app chrome around it.
- `<video src="media://…">` (Range-capable privileged protocol — instant scrubbing) + DOM overlay elements positioned from ResolvedLayout.
- **Safe-zone toggle** (eye icon): overlays translucent TikTok chrome — top search pill, right action rail, bottom caption strip — at true safe-zone geometry (see export-spec). Purely visual, never rendered.
- **Playback bar**: play/pause (space), current time; scrubbing updates the `<video>` and the DOM preview is static (text doesn't move).
- **Trim range**: range handles under the bar; violet region = kept. Snapping to 0.1s; values shown on handles. Loop playback within trim.

**Right — settings**
- `TEMPLATE SETTINGS`: inputs from template's `inputs[]` (hook textarea with live line-count/char-count against `maxLength` and `maxLines`), then knobs in declared order.
- `CLIP`: audio keep/mute radio; trim numeric readouts (editable); "reset trim".
- Validation: shrink-to-fit failure → red hint under textarea: "Too long for 4 lines even at 44px — shorten". Export disabled while invalid.

**Top bar**
- Back (autosaves), filename + probe summary chips, **Export** button (primary accent).

**Bottom render bar (conditional)**
- Progress %, ETA (from rolling average of parsed `out_time_us`), Cancel.
- On success → green toast: "Exported 27s · 18.4 MB — **Open folder**".
- On failure → red panel with stderr tail in a `<details>`.

## Screen 3 — Settings (modal)

| Section | Controls |
|---|---|
| Output | Default folder, filename pattern (`{name}_{date}_{time}` tokens) |
| Encoder | Encoder (Auto/libx264/NVENC…), quality (CRF 17/18/20/23), fps (30/60/source) |
| FFmpeg | Binary source (Auto/system/bundled), version readout, "test" button |
| Storage | Data folder readout + "open", "clear probe cache" (shows size), portable-mode status |
| About | Version, docs link, licenses (electron, ffmpeg, fonts) |

## Interactions & shortcuts

| Key | Action |
|---|---|
| Space | Play/pause preview |
| I / O | Set trim in/out at playhead |
| Ctrl+E | Export |
| Esc | Cancel render (when busy) / close modal |
| Ctrl+S | Force-save project (autosave anyway) |
| ←/→ | Nudge playhead 1 frame (shift: 1s) |

## Component inventory (renderer)

`App` · `HomeScreen` · `ProjectCard` · `EditorScreen` · `TemplatePicker` · `TemplateCard` · `PhonePreview` · `VideoLayer` · `TextLayer` · `SafeZoneOverlay` · `PlaybackBar` · `TrimRange` · `FieldPanel` (renders FieldDef/knobs) · `ExportBar` · `Toast` · `SettingsModal` · `RelinkBanner`.

Store slices (Zustand): `projectStore` (project doc + dirty flag), `renderStore` (active job, progress, result), `settingsStore`.

## Preview performance notes

- All sources play the **original file directly** via `media://` — no proxy pipeline in v0.1 (simplicity audit; 10–60s 1080p repost clips are trivial for hardware-accelerated Chromium). Proxy generation is a documented contingency only, triggered by real-world 4K scrubbing lag.
- Text layer re-renders on every keystroke — cheap (DOM, few nodes). Layout Engine call is < 1ms for our slot counts.

## Accessibility & i18n

- All controls keyboard-reachable; focus rings visible on dark bg.
- English-only v1; all strings in one `strings.ts` from the start (cheap future i18n).
