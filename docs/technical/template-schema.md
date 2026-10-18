# Technical — Template Schema

Version: 1 (bump `schemaVersion` on breaking changes; loader keeps per-version migrations).

Design space for all coordinates: **1080 × 1920 px**. Templates target this exactly; no relative units in v1 (px only — simpler math, easy mental model).

## TypeScript types (source of truth)

```ts
type BackgroundStyle = 'black' | 'white' | 'darkGray' | 'blurVideo';

interface Template {
  schemaVersion: 1;
  id: string;            // 'hook-letterbox', kebab-case, stable
  name: string;          // 'Hook Letterbox'
  description: string;   // one line for the picker card
  thumbnail: string;     // asset path relative to template file
  canvas: {
    width: 1080; height: 1920;
    backgroundStyle: BackgroundStyle;   // engine constructs the Background (no object/string duality)
    blur?: { sigma: number; darken: number };  // only used when backgroundStyle = 'blurVideo'
  };
  safeZones: { top: number; right: number; bottom: number; left: number }; // px insets
  slots: Slot[];
  knobs: KnobDef[];      // UI-exposed variations (semantic ids, see registry below)
  inputs: FieldDef[];    // what the editor asks the user for
}

type Slot = VideoSlot | TextSlot | ImageSlot | ShapeSlot;  // Image/Shape: phase 2

interface SlotBase {
  id: string;
  x: number;                     // left edge in design space
  width: number;                 // box width
  visible: boolean;
  tStart?: number;               // seconds; omit = 0 (timed slots: M4)
  tEnd?: number;                 // seconds; omit = clip duration
}

interface VideoSlot extends SlotBase {
  type: 'video';
  y: number;                     // top edge of the bounded target box; driven by 'videoTop' when present
  height: number;                // bounded target box height — contain fits inside (width × height),
                                 // so no source aspect ratio can overflow the canvas (re-audit Issue 2)
  fit: 'contain' | 'cover';      // contain = fit inside the box (letter/pillarbox), cover = crop-fill the box
  scale: number;                 // 0.85–1.0 of the target box
  cornerRadius: number;          // px, 0 = square
  borderWidth: number;           // px, 0 = none
  borderColor: string;
}

interface TextSlot extends SlotBase {
  type: 'text';
  bindsTo: string;               // key into inputs/values, e.g. 'hook'
  // Vertical placement. 'fixed' uses the stored y/height.
  // 'aboveVideo' derives them: bottom edge = video.y - gap, top clamped to >= minY —
  // so the text block re-anchors automatically when the video moves (audit C3).
  anchor:
    | { kind: 'fixed'; y: number; height: number }
    | { kind: 'aboveVideo'; gap: number; minY: number };
  fontFamily: 'inter' | 'poppins'; // registered font key, NOT a system font name
  fontWeight: 400 | 600 | 800;
  fontSize: number;              // starting size; shrink-to-fit may reduce
  fontSizeMin: number;           // shrink floor
  lineHeight: number;            // multiplier
  color: string;
  align: 'left' | 'center' | 'right';
  vAlign: 'top' | 'middle' | 'bottom'; // within the resolved box
  maxLines: number;
  wordBreak: 'normal' | 'break-word';
}
```

## Knobs are semantic, not property paths (audit C2 / S4)

`KnobDef` **must not** target properties by string path. There is no `appliesTo`, no dynamic traversal, no lodash.set. Instead: a fixed registry of knob ids the Layout Engine consumes with explicit typed code.

```ts
interface KnobDef {
  id: KnobId;                    // must exist in the registry below
  label: string;
  default: unknown;              // typed per id (see registry); used when project has no override
  control: 'slider' | 'select' | 'toggle' | 'color';
  min?: number; max?: number; step?: number;
  options?: { value: unknown; label: string }[];
}
```

### Knob id registry (engine-supported set — validation rejects unknown ids)

| KnobId | Type | Effect in Layout Engine |
|---|---|---|
| `backgroundStyle` | `BackgroundStyle` | constructs canvas Background (incl. blur params) |
| `videoTop` | `number` (480–700) | sets `video.y`; `aboveVideo` text slots re-anchor |
| `videoCornerRadius` | `number` (0–48) | sets corner radius; chooses covers (solid bg) vs mask+alphamerge |
| `videoScale` | `number` (0.85–1.0) | insets the video box |
| `textAlign` | `'left'\|'center'\|'right'` | text slot align |
| `textFont` | `'inter'\|'poppins'` | text slot fontFamily |
| `textMaxLines` | `number` (2–6) | text slot maxLines |

Extending the registry = adding one typed handler in the engine (a code change, by design — knobs are engine features, templates merely declare them).

## Resolution contract

`Layout Engine` input/output:

```ts
interface UserValues {
  fields: Record<string, string>;   // { hook: 'A wildlife photographer…' }
  knobs: Partial<Record<KnobId, unknown>>; // overrides; KnobDef.default fills the rest
}

interface ResolvedLayout {
  canvas: { width: number; height: number; background: BackgroundStyle; blur?: { sigma: number; darken: number } };
  video: { x: number; y: number; w: number; h: number; cornerRadius: number; borderWidth: number; borderColor: string };
  texts: Array<{
    slotId: string;
    lines: string[];               // final wrapped lines (from shared opentype metrics)
    x: number; y: number;          // first line's top-left
    width: number;
    fontFamily: string; fontWeight: number;
    fontSize: number;              // final (possibly shrunk) size
    lineHeightPx: number;
    color: string; align: string;
    tStart?: number; tEnd?: number;
  }>;
  warnings: string[];              // safe-zone ink, shrink floor hit, etc. (non-fatal)
}
```

### Text measurement (audit Bug 3 / Fix 3 — normative)

Line breaking and shrink-to-fit use **opentype.js** glyph-advance metrics (+ kerning) computed from the bundled TTFs — pure JavaScript, so the exact same numbers run in the Electron main process, the sandboxed Chromium renderer, and Vitest.

- `src/shared/layout/text.ts` receives font data through an injected loader — `loadFont(key: FontKey): ArrayBuffer` — provided by the host process (fs in main/CLI/tests; in the renderer the bytes arrive via the preload bridge's `getFontBuffer` IPC — no `fetch`/asset-path ambiguity in the sandbox). This keeps `src/shared` platform-free while guaranteeing identical metrics everywhere.
- Drawing consumes **pre-broken lines only**: canvas `fillText` per line, DOM per-line spans (`white-space: pre`). Neither rasterizer ever re-wraps, so DOM-vs-Skia metric differences cannot change line breaks.
- `string-width` (column-count) metrics are explicitly banned for wrapping — proportional fonts make them wrong.

### Text shrink-to-fit algorithm (normative)

```
size = slot.fontSize
while size >= slot.fontSizeMin:
    lines = wordWrap(text, slot.width, fontKey, size)   // opentype advances
    if lines.length <= slot.maxLines: break
    size -= 2
if lines.length > slot.maxLines:
    return ValidationError('text-too-long', { slotId, maxLines })
```

## Built-in Template 1 JSON (complete example)

```json
{
  "schemaVersion": 1,
  "id": "hook-letterbox",
  "name": "Hook Letterbox",
  "description": "Clip letterboxed upper-center, bold hook on top. Classic story opener.",
  "thumbnail": "thumb-hook-letterbox.png",
  "canvas": {
    "width": 1080, "height": 1920,
    "backgroundStyle": "black",
    "blur": { "sigma": 30, "darken": 0.05 }
  },
  "safeZones": { "top": 150, "right": 140, "bottom": 420, "left": 0 },
  "slots": [
    {
      "type": "video", "id": "video",
      "x": 0, "y": 520, "width": 1080, "height": 980,
      "fit": "contain", "scale": 1.0,
      "cornerRadius": 24, "borderWidth": 0, "borderColor": "#FFFFFF",
      "visible": true
    },
    {
      "type": "text", "id": "hook",
      "bindsTo": "hook",
      "x": 48, "width": 880,
      "anchor": { "kind": "aboveVideo", "gap": 32, "minY": 150 },
      "fontFamily": "inter", "fontWeight": 600,
      "fontSize": 68, "fontSizeMin": 44, "lineHeight": 1.25,
      "color": "#FFFFFF", "align": "left", "vAlign": "bottom",
      "maxLines": 4, "wordBreak": "normal",
      "visible": true
    }
  ],
  "knobs": [
    { "id": "backgroundStyle", "label": "Background", "control": "select", "default": "black",
      "options": [
        { "value": "black",    "label": "Black" },
        { "value": "white",    "label": "White" },
        { "value": "darkGray", "label": "Dark gray" },
        { "value": "blurVideo","label": "Blurred video" }
      ] },
    { "id": "videoTop", "label": "Video position ↓", "control": "slider", "default": 520, "min": 480, "max": 700, "step": 4 },
    { "id": "videoCornerRadius", "label": "Corner rounding", "control": "slider", "default": 24, "min": 0, "max": 48, "step": 4 },
    { "id": "textAlign", "label": "Text align", "control": "select", "default": "left",
      "options": [ { "value": "left", "label": "Left" }, { "value": "center", "label": "Center" } ] }
  ],
  "inputs": [
    { "key": "hook", "label": "Hook text", "control": "textarea",
      "placeholder": "A wildlife photographer put a microphone beside a baby squirrel…",
      "maxLength": 220, "required": true }
  ]
}
```

Notes on the defaults:
- Video target box: y 520 → **1500** (height 980 = canvas 1920 − videoTop 520 − bottom safe zone 420). `contain` inside `1080×980` then yields: 16:9 → **1080×608**; portrait 9:16 → **551×980** centered at x ≈ 264 (pillarboxed); 4:3 → **1080×810** (width-limited). No source aspect can spill past the canvas or into the bottom caption zone (re-audit Issue 2).
- Hook box: x 48 → **928** (48 + 880), keeping wrapped ink clear of the right rail at x 940 (audit C1).
- The hook is anchored **above the video**: resolved box top = `max(minY=150, …)`, bottom = `video.y − 32`. With default `videoTop=520` the block spans y 150–488; `vAlign: bottom` makes the last line hug the video regardless of line count — and the whole block follows when the `videoTop` knob moves the video.

## Validation rules (loader enforces)

1. `schemaVersion` present and supported.
2. Slot boxes inside canvas (`0 ≤ x`, `x + width ≤ 1080`, `0 ≤ y`, `y + height ≤ 1920`) — the video slot's `height` is an explicit bounded target box, so validation is direct (no worst-case recomputation needed).
3. Exactly one `video` slot in v1 (multi-video = M4+).
4. Every `TextSlot.bindsTo` matches an `inputs[].key`; every required input has a value at resolve time.
5. `fontSize ≥ fontSizeMin ≥ 12`; `maxLines ≥ 1`; `lineHeight` in [1.0, 2.0].
6. Colors are `#RRGGBB`/`#RRGGBBAA`.
7. Every `knobs[].id` **exists in the knob registry**; `default` matches the id's type and range; option lists non-empty for selects.
8. IDs unique across slots; knob ids unique within a template.
9. `anchor.kind = 'aboveVideo'` slots: computed height = `(video.y − gap) − minY` must be ≥ 120px at default `videoTop` (room for at least 2 shrunk lines).

Violations → template rejected with `{ path, message }` shown in the picker; app continues with other templates.

## Versioning

- `schemaVersion: 1` = everything above.
- Additive changes (new optional fields, new registry knob ids) stay v1. Breaking changes (renames, semantic flips) → v2 + a migration function `migrate(template): Template` per version step, run at load.
