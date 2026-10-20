# Technical — UI & IPC (Downloader screen, settings, bridge contract)

Everything the renderer sees. The rule from the batch screen applies twice over: **the renderer runs the same pure parser the core runs** (`src/shared/downloader/urls.ts` + `parseRunInput`), so a green line in the UI is a line main will accept.

## 1. Screen placement & navigation

- `App.tsx`: `type Screen = 'home' | 'editor' | 'batch' | 'downloader'` — the Downloader sits beside Batch, entered from Home exactly like Batch (`onOpenDownloader` prop on `HomeScreen`).
- No new window, no modal maze; Settings additions live in the existing `SettingsModal`.
- Empty state (first visit): headline, one-paragraph how-it-works, the legal line:

  > Download only content you have the right to use. ShortZ stores files locally and never uploads anything.

## 2. Layout

```
┌────────────────────────────────────────────────────────────────────────────┐
│  ← Back    Downloader                                        [Settings ⚙] │
├────────────────────────────────────────────────────────────────────────────┤
│  Paste X status links — one per line. '#' starts a comment.               │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │ https://x.com/someuser/status/1750123456789012352                   │  │
│  │ x.com/other/status/1750999…          ← live per-line verdicts       │  │
│  │ # the funny squirrel one              ← comment, grey                │  │
│  │ https://t.co/abcd1234                 ← "needs expansion" (ok, auto) │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│  3 links · 1 problem on line 2                                            │
│  [ Analyze ]  [ Download ▸ ]  [ Retry failed ]  [ Cancel ]  [ Open folder ]│
├────────────────────────────────────────────────────────────────────────────┤
│  RUN 01JD7… — downloading 2/5                                             │
│  ● someuser / 1750…2352   done      12.3 MB   1280×720   [New project] ⋯  │
│  ● other / 1750…999       skipped — already downloaded                 ⋯  │
│  ◐ third / 1750…777       downloading ▓▓▓▓▓░░░░ 47% · 2.1 MB/s            │
│  ● (line 4)               failed — Post not found or deleted           ⋯  │
│  ○ fifth / 1750…111       queued                                          │
└────────────────────────────────────────────────────────────────────────────┘
```

### Textarea rules (`parseRunInput` — shared, pure)

- One input per line; blank lines ignored; `# …` comment lines ignored (a `#` only starts a comment at line start — X URLs contain no `#`).
- The URL may sit inside surrounding text (a pasted sentence) — the grammar's `.search()`-equivalent extracts it; **at most one link per line** (a second link on the same line is a `multiple-links` problem, forcing the user to split it rather than silently guessing).
- Quotes ("Copy as path"-style) stripped; trailing punctuation `,` `)` tolerated.
- Problem codes: `no-link`, `invalid-id` (status-shaped, implausible), `short-link` (t.co — *not* a problem, shown as "will expand"), `duplicate` (same tweet id earlier in the list), `multiple-links`.
- Duplicate rule: same `tweetId` after normalization → flagged like Batch's `duplicate-path`; the earlier line wins.

**Freeze while running** (audit rev 2 — the Batch screen does the same): the textarea is `readOnly` while a run is active, and `dlStore` snapshots the parsed lines at `dlStart` into `run.rows`. Incoming `DlProgressEvent.index` values map against that snapshot, never against the live textarea — an edit mid-run cannot shuffle rows.

### Buttons

| Button | Behavior |
|---|---|
| **Analyze** | A normal run with `dryRun: true` — **not** a separate IPC (audit rev 2): rows fill in live (`resolving → planned`) with author/caption/dims/count and the **planned path** (same `naming.ts` the core uses); `Cancel` aborts it like any run |
| **Download** | Start the run (single-flight). Disabled while a run is active |
| **Retry failed** | Re-enqueues only failed/incomplete rows of the last run (reads state) |
| **Cancel** | Abort run; in-flight transfers stop at a chunk boundary (`.part` kept) |
| **Open folder** | `shell.openPath` on the download dir |

Per-row `⋯` menu: New project · Reveal · Copy path · Copy URL · (D5) Convert to GIF.

### Row state machine

```
queued → resolving → planned ─┬→ skipped (already downloaded / duplicate / circuit)
                              ├→ downloading (per-media %) → done
                              └→ failed (DlErrorCode + human sentence)
downloading ─→ cancelled · partial (some media failed) — multi-video rows show per-media chips
```

- Row carries: author @handle, caption (1 line, ellipsized), resolution badge, size, source adapter badge (syndication/fxtwitter/yt-dlp), poster thumbnail (from the local cache via `media://`), planned/actual file name.
- Errors render as **sentence first, code in a tooltip** (`strings.ts` map; e.g. `NOT_EMBEDDABLE` → "Not embeddable — the post is sensitive or protected (not deleted)"). A `NOT_EMBEDDABLE` row shows an inline hint when the fallback is off (audit rev 2): *"Not embeddable via Twitter syndication — enable the fxtwitter fallback in Settings to try harder."* with a settings deep link.

### Keyboard

- `Ctrl+Enter` in the textarea = Download (if parse-clean). `Escape` = close any open row menu. No other shortcuts (screen is simple on purpose).

## 3. IPC contract additions

Types live in `src/shared/downloader/types.ts` and are re-exported by `src/preload/api.d.ts` (same pattern as `BatchRunRequest`).

```ts
// ---------- requests ----------
export interface DlRunRequest {
  /** Non-blank textarea lines as typed; main re-parses — the renderer's parse is preview only. */
  inputs: string[]
  quality?: DlQuality              // 'best' | 'worst' | { maxHeight: number }
  outputDir?: string               // falls back to settings.downloads.dir
  force?: boolean                  // re-download even when complete
  dryRun?: boolean                 // Analyze
}
export type DlQuality = 'best' | 'worst' | { maxHeight: number }

// ---------- progress events (webContents.send 'shortz:dl:progress') ----------
export type DlItemStatus =
  | 'queued' | 'resolving' | 'planned' | 'skipped' | 'downloading'
  | 'ok' | 'partial' | 'failed' | 'cancelled'

export interface DlProgressEvent {
  jobId: string
  /** 0-based index among the run's non-blank lines; total on the terminal event. */
  index: number
  total: number
  /** Lifecycle transitions are immediate; byte ticks are coalesced (~10 Hz) in main. */
  kind: 'item' | 'media-progress' | 'run-done'
  item?: {
    tweetId: string
    status: DlItemStatus
    author?: string
    caption?: string
    /** Ready media:// URL for the cached poster — minted by main (audit rev 2). */
    posterMediaUrl?: string
    error?: string             // human sentence from strings map
    errorCode?: DlErrorCode
    files?: string[]           // absolute paths on ok/partial
    media?: { index: number; status: DlItemStatus; bytes: number; total: number | null }[]
  }
  /** Terminal event only. */
  summary?: { ok: number; skipped: number; partial: number; failed: number; cancelled: number }
}

export interface DlRunSummary { jobId: string; total: number }  // + the summary counters above

// ---------- the bridge ----------
export interface ShortzApi {
  // … existing methods …
  /**
   * Start a run. Analyze IS a run with dryRun: true (audit rev 2 — one path,
   * streaming events, cancellable), not a separate bulk promise.
   * Rejects when one is already active (single-flight).
   */
  dlStart(req: DlRunRequest): Promise<{ jobId: string }>
  /** Aborts the active run (download or analyze) at the next chunk boundary. */
  dlCancel(): Promise<void>
  /** History: newest 100 entries from the state index (audit rev 2: bounded). */
  dlList(): Promise<DlListEntry[]>
  onDlProgress(cb: (e: DlProgressEvent) => void): Unsubscribe
}
export interface DlListEntry {
  tweetId: string; author: string | null; caption: string
  /** Ready media:// URL for the cached poster — minted by main (audit rev 2). */
  posterMediaUrl?: string
  files: { path: string; sizeBytes: number; mediaIndex: number }[]
  status: 'ok' | 'partial' | 'failed'; downloadedAt: string
}
```

Channel names (main): `shortz:dl:start`, `shortz:dl:cancel`, `shortz:dl:list`, `shortz:dl:progress` — the existing `handle()` helper, nothing exotic; Analyze rides `shortz:dl:start` with `dryRun: true` (audit rev 2 — no separate `dl:analyze` channel). The single-flight rule mirrors `exportInFlight`: `dlInFlight` boolean, second `dl:start` rejects with a readable error the renderer turns into a toast.

**Event coalescing** (`main/downloader.ts`): core `media-progress` ticks enter a per-media buffer; a `setTimeout(100)` flush sends the latest tick per media; every non-progress event bypasses the buffer. On `run-done` the buffer is dropped.

**Posters ride the events** (audit rev 2): main downloads the poster during resolve into `downloads/cache/posters/` and ships a ready `posterMediaUrl` — minted with `mintMediaUrl(absPath)` — on the item event and list entry. The renderer never calls `getMediaUrl` for posters (that path validates *video* extensions only and would reject `.jpg`) and never builds `media://` URLs itself; the `media://` handler already serves JPEG/PNG with the right MIME (project thumbnails use the same road).

## 4. Settings additions

`src/shared/domain.ts` gains one additive section (the settings store merges defaults on load, so existing `settings.json` files keep working without a schema bump):

```ts
export interface Settings {
  // … existing …
  downloads: {
    dir: string                                   // default: Videos\ShortZ\Downloads
    layout: 'by-author' | 'by-date' | 'flat'
    filenameTemplate: string                      // '{id}' | '{date}_{id}' | '{author}_{id}_{slug}'
    quality: DlQuality                            // default 'best'
    resolveConcurrency: 1 | 2 | 3 | 4 | 5         // default 4
    downloadConcurrency: 1 | 2 | 3                // default 3
    fallback: 'off' | 'fxtwitter' | 'auto'        // 'auto' = yt-dlp sidecar (D5); default 'off'
    writeSidecars: boolean                        // default true
  }
}
```

Settings modal — new "Downloads" group: folder picker, filename template (with a live example row), quality select, two concurrency steppers (with a "be gentle — X rate-limits" hint), fallback radio (Off / fxtwitter / yt-dlp when D5 ships) with the third-party data note on fxtwitter, sidecar toggle.

## 5. Renderer store (`dlStore.ts`, zustand)

```ts
interface DlState {
  text: string
  lines: ParsedLine[]            // re-parsed (memoized) on every text change
  run: { jobId: string; rows: Map<lineIndex, RowState> } | null
  history: DlListEntry[]
  start(): Promise<void>; analyze(): Promise<void>; cancel(): Promise<void>
  retryFailed(): Promise<void>; openFolder(): Promise<void>
}
```

- `subscribeDlProgress()` wires `onDlProgress` → row updates (same pattern as `batchStore.ts`).
- The renderer **never** computes planned paths itself outside Analyze rows — it renders what main resolved; the only path logic it owns is displaying strings.
- Row actions call existing bridges: New project → `createProject(filePath)` then `projectStore` open (the editor path is the existing one, byte for byte).

## 6. Strings (`strings.ts` additions, the full user-facing copy surface)

Error-code sentences (tooltip carries the code): not found / not embeddable / needs login / no video / rate limited / link expired / network / disk full / write error / integrity / cancelled / circuit open / duplicate / unexpected. Plus: run summary line ("4 done · 1 skipped · 1 failed"), analyze badge, empty state, legal line, settings hints. No error string is composed in a component — the map is the single source.

## 7. What the UI deliberately does not do

- No per-line quality override in MVP (run-level only) — row menus stay short.
- No editable captions/textareas per row — the sidecar holds the caption; the editor's field panel is where text gets typed.
- No drag-out of rows (Explorer already does this better via Reveal).
- No background runs after the window closes — the main process dies with the app; `.part` + state make that safe, not silent.
