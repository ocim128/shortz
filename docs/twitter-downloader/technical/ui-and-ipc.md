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
- **The renderer's parse is a preview only (rev 3 A4/A22):** every line is sent, wrapped as `{ key, lineNumber, text }` — duplicates and junk included — and **main** returns the authoritative verdict per key, including `duplicate` and `multiple-links`. One verdict owner; the row mapping can never shift between the renderer's parse and main's.

**Freeze while running** (audit rev 2 — the Batch screen does the same): the textarea is `readOnly` while a run is active, and `dlStore` snapshots the parsed lines at `dlStart` into `run.rows`. Incoming `DlProgressEvent.index` values map against that snapshot, never against the live textarea — an edit mid-run cannot shuffle rows.

### Buttons

| Button | Behavior |
|---|---|
| **Analyze** | A normal run with `dryRun: true` — **not** a separate IPC (audit rev 2): rows fill in live (`resolving → planned`) with author/caption/dims/count and the **planned path** (same `naming.ts` the core uses); `Cancel` aborts it like any run |
| **Download** | Start the run (single-flight). Disabled while a run is active |
| **Retry failed** | Sends `retryFailed: true` on the run request; **main** derives the set from state + the last `jobId` (rev 3 A5 — the field exists in the contract now, not at implementation time) |
| **Cancel** | Abort run; in-flight transfers stop at a chunk boundary (`.part` kept); exactly one `run-done` still arrives (rev 3) |
| **Open folder** | `shortz:dl:openFolder` → `shell.openPath` on the download dir (rev 3 A5) |

Per-row `⋯` menu: New project · Reveal · Copy path · Copy URL · (D5) Convert to GIF.

### Row state machine

```
queued → resolving → planned ─┬→ skipped (already downloaded / duplicate / circuit)
                              ├→ downloading (per-media %) → done
                              └→ failed (DlErrorCode + human sentence)
downloading ─→ cancelled · partial (some media failed) — multi-video rows show per-media chips
```

- Exactly one `run-done` per run — cancel included (rev 3 A8): `cancelled` rows and the summary chip both come from it, and `dlInFlight` clears in its handler. No code path may return from a run without emitting it.
- Row carries: author @handle, caption (1 line, ellipsized), resolution badge, size, source adapter badge (syndication/fxtwitter/yt-dlp), poster thumbnail (from the local cache via `media://`), planned/actual file name.
- Errors render as **sentence first, code in a tooltip** (`strings.ts` map; e.g. `NOT_EMBEDDABLE` → "Not embeddable — the post is sensitive or protected (not deleted)"). A `NOT_EMBEDDABLE` row shows an inline hint when the fallback is off (audit rev 2): *"Not embeddable via Twitter syndication — enable the fxtwitter fallback in Settings to try harder."* with a settings deep link.

### Keyboard

- `Ctrl+Enter` in the textarea = Download (if parse-clean). `Escape` = close any open row menu. No other shortcuts (screen is simple on purpose).

## 3. IPC contract additions

Types live in `src/shared/downloader/types.ts` and are re-exported by `src/preload/api.d.ts` (same pattern as `BatchRunRequest`).

```ts
// ---------- requests ----------
/** One textarea line, identified (audit rev 3 A4 — mirrors BatchRenderItem.id). */
export interface DlInput {
  /** Stable per-line key from the parser; echoed on every event for this line. */
  key: string
  /** 1-based physical line number (blank/comment lines keep their number). */
  lineNumber: number
  /** The line text exactly as typed (trimmed). */
  text: string
}
export interface DlRunRequest {
  /** EVERY line — duplicates and junk included; main owns all verdicts (rev 3). */
  inputs: DlInput[]
  quality?: DlQuality              // 'best' | 'worst' | { maxHeight: number }
  outputDir?: string               // falls back to settings.downloads.dir
  force?: boolean                  // re-download even when complete
  dryRun?: boolean                 // Analyze
  /** Retry-failed: main derives the set from state + the last run (rev 3 A5). */
  retryFailed?: true
}
export type DlQuality = 'best' | 'worst' | { maxHeight: number }

// ---------- progress events (webContents.send 'shortz:dl:progress') ----------
export type DlItemStatus =
  | 'queued' | 'resolving' | 'planned' | 'skipped' | 'downloading'
  | 'ok' | 'partial' | 'failed' | 'cancelled'

export interface DlProgressEvent {
  jobId: string
  /** The input line this event belongs to (audit rev 3 A4). */
  key: string
  /** Echoed so rows can be labelled "line 4" without re-parsing. */
  lineNumber: number
  /** 0-based position among the run's accepted items; total on the terminal event. */
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
  /** Opens settings.downloads.dir in Explorer (audit rev 3 A5). */
  dlOpenFolder(): Promise<void>
  /** Directory picker for the settings folder field (audit rev 3 A5). */
  pickDirectory(): Promise<string | null>
  onDlProgress(cb: (e: DlProgressEvent) => void): Unsubscribe
}
export interface DlListEntry {
  tweetId: string; author: string | null
  /** From the tweet row (schema v2 stores caption/url — audit rev 3 A6). */
  caption: string
  /** Ready media:// URL for the cached poster — minted by main (audit rev 2). */
  posterMediaUrl?: string
  files: { path: string; sizeBytes: number; mediaIndex: number }[]
  /** Derived from media rows: some ok + some failed = 'partial' (not stored). */
  status: 'ok' | 'partial' | 'failed'
  downloadedAt: string
}
```

Channel names (main): `shortz:dl:start`, `shortz:dl:cancel`, `shortz:dl:list`, `shortz:dl:openFolder`, `shortz:dl:progress` — Analyze rides `shortz:dl:start` with `dryRun: true`. Handlers register through **`registerDownloaderIpc(deps)` called from `registerIpcHandlers()`** (rev 3 A17): `handle()` and the flight flags are private to `ipc.ts`, so a small `JobSlots` object (`exportInFlight`, `dlInFlight`) is injected and the single-flight rules live in one place. Divergence from batch, deliberately: a download run does **not** block on `exportInFlight` (network vs CPU bottleneck); the one real collision — re-downloading a file an export is reading — lands as a retried `EPERM` via `moveWithRetry`, not a deadlock. Second `dl:start` rejects with a readable error the renderer toasts.

**Event coalescing** (`main/downloader.ts`): core `media-progress` ticks enter a per-media buffer; a `setTimeout(100)` flush sends the latest tick per media; every non-progress event bypasses the buffer. On `run-done` the buffer is dropped.

**Posters ride the events** (audit rev 2): main downloads the poster during resolve into `downloads/cache/posters/` and ships a ready `posterMediaUrl` — minted with `mintMediaUrl(absPath)` — on the item event and list entry. The renderer never calls `getMediaUrl` for posters (that path validates *video* extensions only and would reject `.jpg`) and never builds `media://` URLs itself; the `media://` handler already serves JPEG/PNG with the right MIME (project thumbnails use the same road).

## 4. Settings additions

`src/shared/domain.ts` gains one additive section. Existing `settings.json` files keep working without a schema bump — but the merge alone is not enough (rev 3 A13): `normalizeSettings()` rebuilds the object field-by-field, so the `downloads` block must be added to **both** `defaultSettings()` and `normalizeSettings()` (`oneOf`/boolean/non-empty-string per field), or a hand-edited `downloadConcurrency: 9` reaches the typed `1|2|3` field untouched:

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

## 6. Copy (`src/shared/downloader/copy.ts` — pure, rev 3 A7)

Error-code sentences live in a **pure shared module**, not the renderer's `strings.ts` (Tier 3): main must phrase the `error` field on events and the CLI/log lines too, and main importing renderer strings would break the tier rule. `copy.ts` maps `DlErrorCode → sentence`: not found / not embeddable (three-cause default: "Can't embed this post — deleted, private, or sensitive.") / needs login / no video / rate limited / link expired / network (main appends the proxy hint where relevant) / disk full / write error / integrity / cancelled / circuit open / duplicate / unexpected. The renderer re-uses the same map for tooltips; `strings.ts` keeps UI chrome only — run summary line ("4 done · 1 skipped · 1 failed"), analyze badge, empty state, legal line, settings hints. No error string is composed in a component.

## 7. What the UI deliberately does not do

- No per-line quality override in MVP (run-level only) — row menus stay short.
- No editable captions/textareas per row — the sidecar holds the caption; the editor's field panel is where text gets typed.
- No drag-out of rows (Explorer already does this better via Reveal).
- No background runs after the window closes — the main process dies with the app; `.part` + state make that safe, not silent.
