# 02 — Architecture & Infrastructure

## Big picture

The downloader is a **feature inside ShortZ**, not a second app. It adds one screen, one main-process job slot, one core subsystem, and one shared pure module — while keeping the existing tier rule intact (pure → core → main glue).

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              ShortZ (Electron app)                           │
│                                                                              │
│  ┌──────────────────────── Renderer (sandboxed) ──────────────────────────┐  │
│  │  React UI  Home ──▶ Downloader screen                                  │  │
│  │            │        ├─ URL textarea (one status link per line)        │  │
│  │            │        ├─ per-line verdicts (parse errors, duplicates)    │  │
│  │            │        ├─ run list: status · progress · error · actions   │  │
│  │            │        └─ Analyze / Download / Cancel / Retry failed      │  │
│  │            └─ "New project" on a finished row ──▶ Editor screen        │  │
│  │  zustand dlStore  ·  strings.ts copy table  ·  ZERO network I/O        │  │
│  └────────────────────────────────┬───────────────────────────────────────┘  │
│                                   │ typed preload bridge (contextBridge)     │
│  ┌──────────────────── Main process (glue only) ─────────────────────────┐  │
│  │  src/main/downloader.ts                                               │  │
│  │   ├─ IPC handlers: dl:start(dryRun) · dl:cancel · dl:list             │  │
│  │   ├─ single-flight job slot (one download run at a time)              │  │
│  │   ├─ settings → engine options   ├─ event coalescing → webContents    │  │
│  │   └─ "New project" reuses the existing createProject path (probe,     │  │
│  │        thumbnail, project.json) — no new import code                  │  │
│  └────────────────────────────────┬───────────────────────────────────────┘  │
│                                   │ plain function calls (no Electron)      │
│  ┌──────────────────── Core (Node-only, Electron-free) ──────────────────┐  │
│  │  src/core/downloader/                                                 │  │
│  │   net/client.ts        allow-listed fetch wrapper + injectable fetch  │  │
│  │   resolve/syndication  Adapter A — cdn.syndication.twimg.com          │  │
│  │   resolve/fxtwitter    Adapter B — api.fxtwitter.com (opt-in)         │  │
│  │   resolve/ytdlp        Adapter D — local yt-dlp sidecar (opt-in, D5)  │  │
│  │   resolve/chain.ts     FallbackChain + error folding                  │  │
│  │   engine/fetch.ts      .part · Range resume · verify · atomic rename  │  │
│  │   engine/throttle.ts   pacing + global 429 pause                      │  │
│  │   store/state.ts       downloads/state.json (skip / retry / history)  │  │
│  │   store/sidecar.ts     <file>.meta.json writer                        │  │
│  │   orchestrator.ts      run(): normalize → resolve → select → download │  │
│  │                        → verify → sidecar → state → events            │  │
│  └────────────────────────────────┬───────────────────────────────────────┘  │
│                                   │ child process (D5 only)                 │
│  ┌──────────────────── Shared (pure TS) ─────────────────────────────────┐  │
│  │  src/shared/downloader/                                               │  │
│  │   urls.ts    URL grammar (x.com/twitter/t.co/intent/embed/mirrors)    │  │
│  │   token.ts   syndication token (one line — V8-exact)                  │  │
│  │   select.ts  quality policy → chosen variant                          │  │
│  │   naming.ts  Windows-safe deterministic paths                         │  │
│  │   types.ts   TweetRef · ResolvedTweet · MediaAsset · results          │  │
│  │   errors.ts  DlErrorCode + retryability map                           │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
└──────────────────────────┬──────────────────────────────┬────────────────────┘
                           │ HTTPS (main only)            │ spawn (D5)
              ┌────────────┴──────────────┐        ┌──────┴──────────────┐
              ▼                           ▼        ▼                     ▼
   cdn.syndication.twimg.com      video.twimg.com  yt-dlp.exe      (opt-in)
   (post JSON + token)            pbs.twimg.com    -J resolve only
              ▲                   (MP4 media)
              │ opt-in
        api.fxtwitter.com
```

**The one rule that keeps this honest:** every byte of network I/O lives in `src/core/downloader` behind `net/client.ts`. The renderer has no `fetch` path, no CSP exception, and no `img src` pointing at a remote host; posters and thumbnails are downloaded by the core and served back through the existing `media://` protocol.

## Components

### 1. Shared pure module — `src/shared/downloader/`

The parts that must behave identically in the renderer preview, the core orchestrator, the CLI, and Vitest:

- **`urls.ts`** — the closed URL grammar: `x.com`/`twitter.com` (+ `www.`, `mobile.`), `/user/status/<id>`, `/i/web/status/<id>`, `/intent/post|tweet?tweet_id=`, `platform.twitter.com/embed/Tweet.html?id=`, mirror hosts (`fxtwitter`, `vxtwitter`, `fixupx`, `twittpr`), `t.co` short links (expansion is the core's job — one hop), and free-text pastes (URLs embedded in a line are extracted). Pure string work: no `node:`, no DOM.
- **`token.ts`** — the syndication token. One function; see `technical/resolver-chain.md` §2. This is pure math and lives here because both unit tests and the core need it.
- **`select.ts`** — quality policy (`best` / `worst` / `maxHeight`) over `Variant[]`; "closest fit above the cap" semantics (port of xdl decision #5).
- **`naming.ts`** — deterministic, Windows-safe path construction (`{id}`, `{date}`, `{author}`, `{slug}`, `{index}`; layouts `by-author` / `by-date` / `flat`). Pure string→string so the renderer can *show the planned path* before anything downloads, and the core computes exactly the same path.
- **`types.ts` / `errors.ts`** — the cross-tier contract: `TweetRef`, `ResolvedTweet`, `MediaAsset`, `Variant`, `Chosen`, per-item results, the `DlErrorCode` enum and its retryability map.

Tier discipline: this folder may not import `node:fs`, `electron`, or `src/core/*`. (Same rule as `src/shared/layout`.)

### 2. Network client — `src/core/downloader/net/client.ts`

One wrapper around Node's built-in `fetch` (undici):

- **Host allow-list enforced before the socket opens.** Resolve/JSON: `cdn.syndication.twimg.com` (+ `api.fxtwitter.com` only when the fallback is enabled, + `x.com`/`twitter.com`/`t.co` for the one redirect hop). Media: `*.twimg.com` and `*.x.com` only (xdl's trust boundary, ported).
- **No cookies, no credentials, no referer.** A minimal `user-agent: ShortZ/<version>`.
- **Injectable fetch** (`fetchImpl: typeof fetch`) — the hermetic-test seam. Tests construct real `Response` objects from recorded fixture JSON; no network, no `undici` dev-dependency.
- **Redirects off by default** (`redirect: 'manual'`), used only for `t.co` expansion where the `Location` header *is* the result. Media URLs are never followed across hosts.
- **Timeouts** per request (resolve 15 s, media idle 30 s) via `AbortSignal.timeout` composed with the job's own abort signal.

### 3. Resolver chain — `src/core/downloader/resolve/`

Adapters implementing one protocol:

```ts
interface Resolver {
  readonly name: 'syndication' | 'fxtwitter' | 'ytdlp'
  resolve(ref: TweetRef, ctx: ResolveCtx): Promise<ResolvedTweet>
}
```

- **A — `syndication.ts`** (always on): `GET https://cdn.syndication.twimg.com/tweet-result` with query params `id`, `lang=en`, the **computed token** (see `technical/resolver-chain.md` §2) and the pinned `features` list; maps `mediaDetails` → `MediaAsset[]`, `video_info.variants` → `Variant[]`. A 404, a tombstone, or a payload without `mediaDetails` is **`NOT_EMBEDDABLE`, never `NOT_FOUND`** — it only means "this endpoint won't tell us".
- **B — `fxtwitter.ts`** (off by default, toggle in Settings): `GET https://api.fxtwitter.com/status/<id>`; one progressive MP4 per video. Enabling it sends the URL list to a third-party operator — the toggle's description says exactly that.
- **D — `ytdlp.ts`** (D5, optional sidecar): `yt-dlp -J --no-warnings <canonical_url>` parsed as JSON (never scraping CLI text output); resolve-only — our engine still downloads, so naming/sidecars/state/dedup are identical across adapters (xdl decision #2).
- **`chain.ts`**: walks adapters in order; **every adapter error falls through**; the terminal error folds as: a **primary-adapter** `NOT_FOUND` wins → else `RATE_LIMITED` (retry signal) → else the last adapter's error. A **non-primary** 404 folds to `NOT_EMBEDDABLE` (rev 3: only the primary adapter — or the failure-path probe — may declare a post deleted), and the message includes the trail (`tried: syndication → fxtwitter`). On a terminal `NOT_EMBEDDABLE`, one failure-path probe (`publish.twitter.com/oembed`) separates deleted (404 ⇒ `NOT_FOUND`) from alive-but-unembeddable (200) — see `technical/resolver-chain.md` §6.

Full mapping tables and error semantics: [`technical/resolver-chain.md`](technical/resolver-chain.md).

### 4. Download engine — `src/core/downloader/engine/`

- **`fetch.ts`** — streams one selected variant to `<dest>.part` with a `Range: bytes=<offset>-` header when a partial file exists; treats `200` on a ranged request as "server ignored Range → restart from zero" (never append a mismatch); verifies the exact total when known; renames atomically (`fs.rename`, same directory, NTFS-atomic); maps `403` to `LINK_EXPIRED` so the **orchestrator** can re-resolve once with a fresh signed URL. The engine never imports resolver types — it takes `(url, dest, ctx)` (xdl decision #10).
- **`throttle.ts`** — port of xdl's `ThrottleState`: jittered min-gap (0.2–0.5 s) between resolve requests, a **global** pause on any 429 (`max(Retry-After, 30 s)`; 3 × 429 within 60 s escalates to `max(2×RA, 120 s)`), and the slot-reservation trick (`_lastRequest` advanced before awaiting, no `await` between read and write) so concurrent workers queue instead of bursting.

Details and the TS shape: [`technical/download-engine.md`](technical/download-engine.md).

### 5. Storage — `src/core/downloader/store/`

- **`state.ts`** — one JSON document, `downloads/state.json`, written atomically (temp + rename, EPERM-retry via the existing `core/store/fs-utils` helpers). Holds per-post rows (`tweetId → author, mediaCount, firstSeen`) and per-media rows (`tweetId:index → filePath, sizeBytes, status, source, downloadedAt`). Completeness is `count(ok rows) === mediaCount && every file stat-able` — not "any row exists" (xdl audit rule; multi-video posts must not false-skip).
- **`sidecar.ts`** — `<name>.mp4.meta.json` next to every media file: caption, author, URL, dimensions, chosen variant URL, size, source adapter, versions. Atomic write (`*.part` → rename). **Write order (crash-safety): media rename → sidecar → state row.**
- **No SQLite in v1.** ShortZ already stores projects/settings/configs as JSON; 10³–10⁴ rows is nothing for a parsed JSON file, and it removes a native dependency from the packaging story. `better-sqlite3` is the documented upgrade path if row counts or write frequency ever justify it (see `03-tech-stack.md` §State).

### 6. Orchestrator — `src/core/downloader/orchestrator.ts`

`run(request, deps): Promise<DlRunSummary>` — the xdl `run_batch` port with its layering intact:

```
normalize inputs (pure)         → dedupe by tweet id (first occurrence wins)
  └─ pre-skip BEFORE any network: state complete + files exist
       → item 'skipped' with zero requests (offline re-runs stay idempotent)
  └─ per item, bounded by resolveSem (default 4), gated by lookahead
     K = downloadConcurrency × 2 pending transfers:
       resolve via chain → select chosen variants → compute planned paths
  └─ per chosen variant, bounded by downloadSem (default 3):
       fetch (resume) → verify → rename → sidecar → state row → emit progress
  └─ item verdict: ok | skipped | partial | failed | cancelled
  └─ circuit breaker: 8 consecutive failed/partial items → remaining become
     'skipped (circuit open)' — a broken night must not grind through 500 URLs
```

- The two semaphores are **independent pools** (xdl decision #23: nesting a transfer inside a resolve slot silently collapses resolve parallelism and lets a 429-stalled transfer occupy a resolve slot).
- **Item-level containment**: an escaping `DlError` becomes that item's failure; any other exception becomes `UNEXPECTED` for that item only. A 500-line batch is never lost to one malformed post. `AbortError` is **rethrown per item and caught at the run boundary** (rev 3): in-flight items end `cancelled` and the run still emits its terminal event — see the cancel contract in `technical/download-engine.md` §3.
- `onEvent` is an injected callback — CLI prints, main coalesces into IPC, tests collect into an array. No Electron, no `console` inside core.

### 7. Main glue — `src/main/downloader.ts`

Thin, like the rest of `src/main`:

- Registers `shortz:dl:*` handlers **via `registerDownloaderIpc(deps)` called from `registerIpcHandlers()`** — `handle()` and the single-flight flags are private to `ipc.ts`, so they arrive as injected deps: a small `JobSlots` object (`exportInFlight`, `dlInFlight`) shared with export/batch keeps the mutual-exclusion rules in one place (rev 3; see `technical/ui-and-ipc.md` §3 for the exact channel/type list).
- Owns **one download job slot** (single-flight). It is *separate* from the export slot: downloading is network-bound and may run while an export burns CPU; two download jobs at once are not allowed (one state writer, one progress stream).
- Reads settings → `RunOptions`; maps `onEvent` → coalesced `webContents.send('shortz:dl:progress', …)` (≈ 10 Hz, plus every lifecycle transition immediately).
- "New project" from a downloaded file reuses the existing `createProject` logic (probe → `project.json` → thumbnail) — no duplicate import path.

### 8. CLI — `src/cli/index.ts` (`pnpm cli dl …`)

Headless twin for debugging and CI: `pnpm cli dl <url…> [--out dir] [--dry-run] [--quality best|720] [--fallback fxtwitter] [--no-meta]`. Exit codes: `0` all ok/skipped, `1` partial, `2` all failed, `130` cancelled. This is the D1/D2 milestone's "GUI-less heart", mirroring how M1 was built as a CLI first.

## Data flow — one batch

```
User clicks Download
   │
   ▼
Renderer parses the textarea (shared parser) → items[{url, lineNo}] with per-line problems
   │  IPC shortz:dl:start { inputs, quality, outputDir? }
   ▼
Main: single-flight guard → settings → orchestrator.run(...)
   │
   ├─ normalize (pure): t.co expansion (1 hop) → TweetRef{id, user, canonical}
   │     dedupe → per-item tasks
   ├─ pre-skip: state complete + files exist → 'skipped' (ZERO network I/O)
   ├─ resolve (lookahead-bounded ≤ K = 2× download concurrency):
   │     chain → ResolvedTweet{author, text, createdAt, media[]}
   ├─ select: best variant per video/gif asset → Chosen[]
   ├─ plan: naming.ts → absolute paths (root = settings.downloads.dir)
   │
   ├─ download (sem 3): GET variant URL, Range resume, stream to .part
   │     ├─ 429 → global pause, retry
   │     ├─ 403 → LINK_EXPIRED → orchestrator re-resolves once → new URL
   │     └─ verify size → rename → sidecar → state row
   │
   └─ events → main coalesces → 'shortz:dl:progress' → dlStore
   ▼
Summary { total, ok, skipped, partial, failed, cancelled } → toast + row states
```

## Process model & concurrency

| Concern | Decision |
|---|---|
| Process | Everything in the main process; no worker threads, no child processes (except `yt-dlp.exe` in D5). Node's async I/O keeps the UI responsive; the renderer never awaits a byte. |
| Job slots | **One** download run at a time (single-flight in `main/downloader.ts`). A second click = disabled button, mirroring export. |
| Parallelism inside a run | `resolveSem = 4`, `downloadSem = 3` (settings range 1–5 / 1–3). Resolves overlap earlier transfers — a batch's network wait is the slowest chain, not the sum. **Bounded lookahead** (rev 2): an item resolves only while fewer than `downloadConcurrency × 2` transfers are pending — resolve never runs a whole batch ahead of download (rate limits + signed-URL expiry). |
| Cancel | One `AbortController` per run; per-item links composed from it. Cancel mid-transfer keeps the `.part` (resume later) and marks the item `cancelled`. Cancel between items stops scheduling immediately. **Exactly one `run-done` event per run, always** — cancel included — so `dlInFlight` can never leak (rev 3). |
| Cross-feature | Downloader may run during an export/batch render (different bottleneck). Shared resources are read-only (settings, probe cache) or same-dir-only (state file, written by one job). |
| Progress | Core emits fine ticks; main coalesces to ~10 Hz; every status transition (resolving→downloading→done) is sent immediately so rows never look stuck. |

## Storage & infrastructure

| Thing | Where |
|---|---|
| Downloaded media (default) | `%USERPROFILE%\Videos\ShortZ\Downloads\x\<author>\<id>.mp4` — user-configurable; portable mode keeps the *state* under `.\data\downloads` while media default stays in Videos (or a single portable root if the user sets it) |
| State index | `<dataDir>\downloads\state.json` (`%APPDATA%\shortz\downloads\state.json`, or `.\data\downloads\state.json` in portable mode) |
| Sidecars | Next to each media file: `<name>.mp4.meta.json` |
| Poster/thumb cache | `<dataDir>\downloads\cache\posters\<id>_<index>.jpg` (fetched by core, served via `media://`) |
| Temp partials | Next to the destination: `<name>.mp4.part` (resume across runs and restarts) |
| Job events | In-memory only; nothing persisted per tick |

Rationale for media outside `%APPDATA%`: downloaded videos are user content the user will drag into other tools; burying hundreds of MB in AppData is hostile. State stays in the data dir because it is app bookkeeping.

## Network posture & security

| Rule | Enforcement |
|---|---|
| Only the Downloader touches the network | All `fetch` calls in `src/core/downloader/net/client.ts`; lint rule / review checklist: no `fetch(` elsewhere in `src/` |
| Host allow-list | Checked in the client before sending: `cdn.syndication.twimg.com`, `api.fxtwitter.com` (opt-in), `t.co`, `x.com`, `twitter.com` for redirects; `*.twimg.com`, `*.x.com` for media. Exact-suffix matching, no `endsWith('twimg.com')` traps (`evil-twimg.com` must fail) |
| No credentials | No cookie jar, no auth headers, `credentials: 'omit'`. Login-walled posts fail with `AUTH_REQUIRED` |
| Renderer isolation | `contextIsolation: true`, `sandbox: true` (unchanged); no remote `img`/`media` sources; CSP unchanged. Posters are proxied through `media://` from a local cache |
| Path safety | File names are produced by the pure sanitizer (reserved names, control chars, trailing dots/spaces, 120-char segments, surrogate-safe truncation); destination is always under the configured root — a `..` in a caption can never escape |
| Explicit action only | No request on screen open, no prefetch, no retry after app restart unless the user clicks again |
| Legal note (UI, one line) | "Download only content you have the right to use. ShortZ stores files locally and never uploads anything." — shown once in the Downloader empty state |

## Failure handling

| Failure | Behavior |
|---|---|
| Malformed line | Caught in the renderer parser; the line is marked, never sent; batch proceeds |
| Deleted post | `NOT_FOUND` — probe-confirmed (oembed 404) or primary-adapter 404; otherwise the honest "deleted, private, or sensitive" copy (rev 3) |
| Sensitive/protected post | `NOT_EMBEDDABLE`; a third party's 404 never wins the fold and the probe (200) confirms the post is alive — the line never claims "deleted" (rev 3) |
| Login-walled | `AUTH_REQUIRED` + "ShortZ doesn't sign in to X" |
| No video (photos only) | `NO_VIDEO` per line |
| 429 | Global pause; retry with backoff; after attempts → `RATE_LIMITED` "X is rate-limiting — try later" |
| Signed media URL expired (403 mid-transfer) | `LINK_EXPIRED` → one orchestrator re-resolve with a fresh URL → resume the `.part` |
| Interrupted exactly at 100% (`.part` == remote size) | `416` on the Range probe → finalize the `.part` directly (verify + rename), no failed attempt (rev 2) |
| Network down | `NETWORK` fast-fail per item (15 s connect timeout), batch continues |
| Disk full | `DISK_FULL` on that item; remaining items of that post marked `partial`; batch continues |
| App crash mid-download | `.part` + sidecar-less file are inert; next run resumes or restarts cleanly (size verify decides) |
| State file corrupt | Quarantined (`.corrupt-<ts>`), rebuilt empty; files on disk are re-finalized on next resolve ("file + sidecar present, no row" → write row, no re-download) |
| `yt-dlp` missing/stale (D5) | Fallback silently skipped when `auto`; explicit `ytdlp` mode fails with a clear install/update message |
| Circuit open (8 consecutive failures) | Remaining items marked `skipped (circuit open)`; one line in the summary; user retries later |

## Why not a separate app / the xdl sidecar

ShortZ could have shipped xdl as a bundled Python sidecar. It was rejected because it doubles the runtime/packaging surface, adds a process boundary to parse, and — decisively — the token algorithm that forced xdl into a byte-exact V8 port is *native* in V8. Full comparison in [`03-tech-stack.md`](03-tech-stack.md).
