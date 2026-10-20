# 01 — Goals & Scope

## The problem

ShortZ's loop starts at *"drop a clip"*. In practice the clip usually comes from X: a repost source, a clip someone shared, a video the user wants to reframe for TikTok. Today that step is:

1. Leave ShortZ.
2. Paste the link into a download site (ads, popups, sometimes a whole page of "choose quality" buttons).
3. Wait, get a file in `Downloads`, rename it or lose it among 200 other files.
4. Drag the file back into ShortZ.

Three tools, five context switches, zero memory: next week the same post is downloaded again because nobody remembers whether it was already done.

xdl (the side project) solved exactly this for the command line and a localhost page. ShortZ needs the same pipeline **inside the app**, wired to the thing ShortZ does next: editing.

## The goal

One screen where the loop is:

```
paste status links → download (batch) → pick a downloaded file → edit → export
```

**Time budget:** paste 5 links → all 5 files on disk in well under a minute of human time (network time excluded). Re-running the same 5 links must finish in seconds — everything is skipped, nothing is re-downloaded.

The output must be a normal local video file that ShortZ's existing ingest accepts: MP4/H.264, probe-able, draggable, project-creatable.

## Product goals

| # | Goal | Measure |
|---|------|---------|
| DG1 | Paste → file: single status URL to playable MP4 without leaving the app | One paste, one click; no browser hop |
| DG2 | Batch is the normal case, and it costs nothing extra | 20 links in one textarea → 20 files; per-line verdicts; one bad line never kills the batch |
| DG3 | Idempotent: re-runs skip, failures retry | Same batch twice → 2nd run is all `skipped`; "Retry failed" re-runs only failures |
| DG4 | Understandable failures | Every failure line carries a typed code + human sentence (deleted / protected / no video / rate-limited / expired link) |
| DG5 | Download → edit is one click | Finished item → "New project" opens the editor with a valid probe |
| DG6 | Safe by construction | Only documented hosts; no cookies/credentials; renderer never talks to the network; nothing downloads without an explicit click |
| DG7 | Never blocks the UI | Downloads stream in the main process; the renderer gets coalesced progress events; cancel works mid-file |

### G6′ — the amended offline promise

The main plan's G6 said *"Runs fully offline, zero accounts, zero telemetry."* That promise is kept, precisely restated:

- **Zero accounts** — unchanged. No X login, no API key, no OAuth.
- **Zero telemetry** — unchanged. Nothing about usage leaves the machine.
- **Offline by default** — the app boots, edits, renders and exports with the network cable pulled. The Downloader screen is the only place that can make a request, and only after the user clicks Download (or Analyze).
- **No unprompted network** — no update pings, no prefetching, no background retries after the user closed the app.

This is an honest amendment, not a loophole: the feature exists because the user explicitly asks it to fetch something.

## Non-goals (this feature, deliberately out of scope)

- **No accounts, login, or cookie import.** Posts that require auth fail with `AUTH_REQUIRED` ("This post needs a logged-in session — ShortZ doesn't do logins"). Protected/age-gated posts are out.
- **No photo/gallery downloads.** ShortZ edits video. Photo-only posts report `NO_VIDEO` per line. (xdl is likewise video/gif only.)
- **No audio-only / MP3 extraction.** That is a music tool's job, not a video editor's.
- **No live streams, Spaces, or DRM content.** Detected and refused (`DRM_UNSUPPORTED` where applicable).
- **No scheduler / watch-folder / auto-download.** Parking lot, not this plan.
- **No built-in browser, no "paste from clipboard" background watcher.** The textarea takes what the user pastes.
- **No upload to TikTok.** Still manual, per the main plan.
- **No silent quality laddering.** One selected variant per media asset; `best` by default, overridable per run.
- **No torrent/magnet/other platforms.** X status URLs only. (The URL parser is a closed grammar, not a plugin system.)

## User stories

### DU1 — The repost source (primary)
> As a poster, I paste one X status link into ShortZ's Downloader, click Download, and 20 seconds later the video is in my library with its caption saved next to it. I click "New project", pick a template, and export.

### DU2 — The batch of five
> As a poster, I collect five links in a note during the day. In the evening I paste all five (one per line), hit Download, and watch five rows go `resolving → downloading 42% → done`. One of them is a deleted post — that line goes red with "Post not found" and the other four still finish.

### DU3 — The re-run that does nothing
> As a poster, I paste the same five links the next day out of habit. All five come back `skipped — already downloaded` in under two seconds. No network transfer.

### DU4 — Retry only what failed
> As a poster, two of twenty downloads failed last night (rate limit, then a dead link). I click "Retry failed" and only those two are attempted.

### DU5 — The sensitive post
> As a poster, I paste a link to a post the syndication endpoint refuses (sensitive/age-gated). With the optional fxtwitter fallback enabled, ShortZ tries it; without it, the line says "Not embeddable — sensitive or protected post". Either way it does not claim the post was deleted.

### DU6 — Cancel mid-file
> As a poster, I start a 500 MB download on hotel Wi-Fi, then cancel. The partial file is kept as `.part`; when I hit Download again on that link, it resumes from where it stopped instead of restarting.

### DU7 — The multi-video post
> As a poster, I paste a post with three videos. I get `<id>.mp4`, `<id>_v2.mp4`, `<id>_v3.mp4`, each with its own sidecar, and the item only counts as complete when all three are `ok`.

### DU8 — Offline
> As a poster on a plane, I open ShortZ, edit an existing project, and export. Nothing spins, nothing warns about connectivity. The Downloader screen's Download button fails fast with `NETWORK` if I try it, and says so per line.

## MVP definition

Shipped when **D0–D3 are done** (see [`04-roadmap.md`](04-roadmap.md)):

- Downloader screen with single + batch textarea input, per-line parsing verdicts, live per-item status/progress, cancel.
- Resolver: syndication only (+ fxtwitter when the user enables it in Settings).
- Engine: streaming download with `.part` resume, exact-size verification, atomic rename, 429-aware pacing, per-item retry.
- Storage: deterministic naming, sidecars, JSON state index, skip/retry-failed.
- "New project" hand-off into the editor.
- Settings section for download dir, quality, concurrency, fallback toggle, sidecar toggle.

**Not MVP:** yt-dlp sidecar fallback, HLS remux, GIF conversion, circuit breaker tuning — all D4/D5.

## Acceptance tests

Mirroring the main plan's A1–A6 style; each is a scripted, repeatable check.

| # | Test | Pass condition |
|---|------|----------------|
| DA1 | Single URL, happy path | One MP4 + one `.meta.json` + one state row; file probes as H.264 video with expected dimensions |
| DA2 | Batch: 3 valid links + 1 malformed line + 1 deleted post | 3 `ok`, malformed line fails at parse (no network), deleted post fails typed (`NOT_FOUND`); batch summary `3 ok / 2 failed`; no crash, no partial state |
| DA3 | Idempotent re-run | Second identical run: all `skipped` with **zero network requests** (state checked before resolve — works offline; rev 2) |
| DA4 | Cancel + resume | Cancel at ~40%; `.part` exists; re-run completes by Range resume (server log shows `Range: bytes=…`) and final size verifies |
| DA5 | 429 handling (simulated clock) | First 429 pauses ≥ `max(Retry-After, 30 s)`; 3 × 429 within 60 s → pause ≥ 120 s; item then succeeds or lands `RATE_LIMITED` |
| DA6 | Multi-video post | `_v2`/`_v3` files + sidecars; item is `partial` if one media fails, `ok` only when all are `ok`; re-run downloads only the missing one |
| DA7 | Sensitive/not-embeddable post | Falls through adapters; terminal message says "not embeddable / protected", never "deleted"; with fallback off, no fxtwitter request is made |
| DA8 | Download → project | "New project" on a finished item creates a project whose probe matches the file; editor opens; export from it succeeds |
| DA9 | Offline behavior | With network disabled, a run fails fast (`NETWORK`) per line in < 5 s each (no endless hangs); app stays responsive; already-downloaded links still skip cleanly with the network off (rev 2) |
| DA10 | Hostile URL | `https://evil.example/x.com/a/status/123` and a `twimg.com.evil.example` media URL are rejected (`URL_UNRECOGNIZED`), no request is made |

## Success signals (after two weeks of real use)

- ≥ 80% of new projects in ShortZ originate from the Downloader (the feature replaced the browser hop).
- Zero re-downloads of the same status under normal use (skip works).
- No user-visible crash or stuck queue; failures are always one line with a readable reason.
