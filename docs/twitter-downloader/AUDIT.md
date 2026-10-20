# Audit — Twitter/X Downloader plan (Rev 2)

**Verdict:** the architecture is sound and unusually well-reasoned; the *integration contract* is
not yet implementable, and three acceptance criteria test behaviour the resolver cannot produce.
Everything below was checked against this repo (not just the prose).

Legend: **P0** = blocks D0–D2 or makes an acceptance test impossible · **P1** = correct but will
bite during implementation · **P2** = consistency/polish.

---

## P0 — fix before writing code

### A1. A deleted post can never report "deleted" — and with the fallback on, a *sensitive* post can

The chain refuses to call syndication's 404 authoritative (`NOT_EMBEDDABLE`), which is the right
call — but then `NOT_FOUND` is assigned to fxtwitter and made to *win* the fold:

| Doc | States |
|---|---|
| [resolver-chain.md](technical/resolver-chain.md):125 | syndication `404` → `NOT_EMBEDDABLE` |
| [resolver-chain.md](technical/resolver-chain.md):139 | fxtwitter `404` → `NOT_FOUND` **definitive** |
| [resolver-chain.md](technical/resolver-chain.md):170 | fold: `NOT_FOUND` wins → `RATE_LIMITED` → last |
| [01-goals.md](01-goals.md):109 (DA2) | "deleted post fails typed (`NOT_FOUND`)" |
| [01-goals.md](01-goals.md):114 (DA7) | sensitive post must **never** say "deleted" |

Consequences:

1. **Default chain (syndication only):** DA2 is unachievable. A deleted post yields
   `NOT_EMBEDDABLE` → "Not embeddable — sensitive or protected", which is wrong for the *most
   common* failure and contradicts DU2 ([01-goals.md](01-goals.md):69: "that line goes red with
   'Post not found'").
2. **With fxtwitter enabled:** fxtwitter 404s sensitive/protected posts, so `NOT_FOUND` wins the
   fold and the UI says "Post not found or deleted" for a post that exists — the exact regression
   DU5/DA7 exist to prevent.

**Fix**

- Fold rule: `NOT_FOUND` is terminal **only from the primary adapter**, or when every adapter
  agrees. A third party's 404 becomes `NOT_EMBEDDABLE` (with the trail).
- Default copy for a 404-shaped refusal names all three causes honestly: *"Can't embed this post —
  deleted, private, or sensitive."* (One sentence, no extra request.)
- If you want the real distinction (recommended, since it's the common case): add **one**
  confirmation probe on the *failure* path only — a `HEAD`/`GET` of the canonical status URL
  (already allow-listed for redirects) or `publish.twitter.com/oembed?url=…`; `404` ⇒
  `NOT_FOUND`, `200` ⇒ `NOT_EMBEDDABLE`. Worth 30 minutes of live experimentation in D1 before
  committing to it.
- Rewrite DA2/DA7 to state which chain composition they assume, and add a third test: *"sensitive
  post, fxtwitter enabled → still `NOT_EMBEDDABLE`"*. That's the test that would have caught this.

### A2. The plan's only concrete golden vector is wrong (verified)

[resolver-chain.md](technical/resolver-chain.md):94 says id `"20"` → `"6dq1a2xwd9"`. Running the
doc's own one-liner:

```
((Number('20')/1e15)*Math.PI).toString(36)  →  "0.000000006dq1a2xwd93"
after .replace(/(0+|\.)/g,'')               →  "6dq1a2xwd93"      ← 11 chars
```

The doc's vector is missing the trailing `3`. A D0 test written from this doc fails immediately,
and the "obvious" repair is to change the algorithm — which is the one thing the doc says not to do.

**Fix:** don't port vectors from prose. Regenerate them from the exact one-liner on Node ≥ 20,
commit the generator alongside the vectors, and keep one *hand*-verified vector (the real token the
live endpoint accepts) as the anchor. Also re-check the other 16 "from xdl's `test_token.py`"
vectors the same way — that file isn't in the repo (see A3).

### A3. Half the plan's authority is unverifiable in this repo

[README.md](README.md):6 cites `../downloader` — the `xdl` package with `DECISIONS.md` #1–#27 —
as "prior art (M0–M6 shipped)". `docs/downloader/` **does not exist**, and neither does
`DECISIONS.md`. Yet ~20 passages justify a decision as "port of xdl D9/D10/D13/D15/D23/D27" and
[03-tech-stack.md](03-tech-stack.md):128 cites "the 17 Node-computed tokens from xdl's
`test_token.py`". Nobody implementing or reviewing this plan can check any of it.

**Fix:** vendor the reference impl under `docs/downloader/` (even just `DECISIONS.md` + the test
files), or replace every "port of D#" with the one-line rationale inline. As written, the plan asks
for trust it doesn't transfer.

### A4. The IPC contract can't map a progress event to a row

`DlRunRequest.inputs: string[]` ([ui-and-ipc.md](technical/ui-and-ipc.md):83) plus
`DlProgressEvent.index` = "0-based index among the run's **non-blank** lines"
([ui-and-ipc.md](technical/ui-and-ipc.md):99) loses two things the UI needs:

- the **physical line number** — the mock layout shows `● (line 4) failed`
  ([ui-and-ipc.md](technical/ui-and-ipc.md):33), but `index` counts non-blank lines, so it cannot
  be labelled;
- the **stable identity** of a row — the doc says the store maps events against a snapshot of the
  *renderer's* parse while `index` is defined over *main's* parse; any disagreement (a dropped
  duplicate, a `multiple-links` line) silently shifts every row below it.

This repo already solved this for batch: `BatchRenderItem.id` is a "stable per-line key from the
parser" and `BatchLine.lineNumber` is carried through ([src/shared/batch/parse.ts](src/shared/batch/parse.ts):40).

**Fix:** `inputs: { key: string; lineNumber: number; text: string }[]`, and echo `key` (not
`index`) on every event. Then main owns all verdicts — including `duplicate` and
`multiple-links` — and the renderer stops dropping lines before sending (see A22).

### A5. Three buttons in the spec have no channel behind them

[ui-and-ipc.md](technical/ui-and-ipc.md):53–56 specifies **Retry failed** and **Open folder**;
[ui-and-ipc.md](technical/ui-and-ipc.md):172 specifies a settings **folder picker**. But:

- `DlRunRequest` has no `retryFailed`/`ids` field ([ui-and-ipc.md](technical/ui-and-ipc.md):82–89),
  so "re-enqueues only failed/incomplete rows of the last run" is not expressible;
- the channel list is start/cancel/list/progress only
  ([ui-and-ipc.md](technical/ui-and-ipc.md):146) — no open-folder;
- the bridge has `pickFile()` and nothing else for directories
  ([src/preload/api.d.ts](src/preload/api.d.ts):195).

**Fix:** `retryFailed?: true` on `DlRunRequest` (main derives the set from state + last `jobId`),
`shortz:dl:openFolder` → `shell.openPath(dir)`, and a `pickDirectory()` bridge method
(`dialog.showOpenDialog({ properties: ['openDirectory'] })`). All three are ~10 lines each; the cost
of discovering them mid-D3 is a day.

### A6. `dlList` promises fields the state schema doesn't store

`DlListEntry` carries `status: 'ok' | 'partial' | 'failed'`, `caption`, `downloadedAt`
([ui-and-ipc.md](technical/ui-and-ipc.md):137–143). The schema in
[storage-naming.md](technical/storage-naming.md):89–113 has `tweets{author,mediaCount,firstSeen}`
and `downloads{...status}` — **no caption, no item verdict, no run/`partial` concept**. So the
history panel cannot be built from it.

**Fix now, while there are no files on disk:** add `caption` (and `url`) to the `tweets` row, and a
`runs` map (`jobId → {startedAt, finishedAt, total/ok/skipped/failed}`); derive `partial` from media
rows. `batchId` already exists on media rows and hangs off nothing. Doing this now is free; doing it
after D3 is a migration.

### A7. Main cannot produce the error sentences the contract promises

Events carry `error?: string` — "human sentence from strings map"
([ui-and-ipc.md](technical/ui-and-ipc.md):111) — and §6 makes `strings.ts` "the single source"
([ui-and-ipc.md](technical/ui-and-ipc.md):191). But `strings.ts` is
[src/renderer/src/strings.ts](src/renderer/src/strings.ts) — Tier 3. Main importing it breaks the
purity tiers the plan explicitly cites ([02-architecture.md](02-architecture.md):79).

**Fix:** put `DlErrorCode → sentence` in `src/shared/downloader/copy.ts` (pure: no `node:`, no DOM),
consumed by main (for `error`) and by the renderer (for the same strings). `strings.ts` keeps
UI chrome only. Alternatively send `errorCode` + params only and let the renderer phrase it — but
then the CLI and `main.log` have no readable text, which is worse.

### A8. The cancel contract contradicts itself

- [02-architecture.md](02-architecture.md):141 — "`AbortError` stays uncaught on purpose."
- [download-engine.md](technical/download-engine.md):154 — "AbortError … is NOT caught — it drains
  the run."
- [download-engine.md](technical/download-engine.md):158 — "in-flight items end `cancelled`, summary
  says so."

If nothing catches it, no item verdict is written and no `run-done` is emitted: the renderer keeps
rows spinning forever, and `dlInFlight` (A17) may never clear.

**Fix:** define the contract explicitly — *exactly one `run-done` event per run, always*. Catch
`AbortError` at the **run** boundary (item-level `try/catch` re-throws it), mark in-flight items
`cancelled`, emit `run-done` with `cancelled`, return the summary. Then the CLI's exit 130 and the
UI's `cancelled` chip both work.

### A9. Resume integrity is size-only — same-size corruption passes

[download-engine.md](technical/download-engine.md):50–57 detects a changed remote object only via
`size !== total`. A re-encode or a different CDN variant that happens to be the same length yields a
file stitched from two encodings that verifies fine. The doc's own `.part`-across-restarts story
(DU6, DA4) makes this reachable: the signed URL is re-minted on every resolve.

**Fix:** capture `ETag` (or `Last-Modified`) from the first response, persist it beside the partial
(e.g. `<name>.mp4.part.json` → `{ etag, lastModified, total }`), send `If-Range: <validator>` with
the resume request, and treat `200` as "object changed → truncate and restart". Cheap, standard, and
it also removes the "stale `.part` from an older encoding" hand-wave in that section.

### A10. Two engine mechanics as written don't work

1. **`fsync`**: `pipeline(Readable.fromWeb(res.body), createWriteStream(...))`
   ([download-engine.md](technical/download-engine.md):42–46) has no `FileHandle`, so
   "`filehandle.sync()` while the handle is open" (line 49) isn't reachable. Use
   `const fh = await fsp.open(part, resume ? 'r+' : 'w')` →
   `fh.createWriteStream({ start, autoClose: false })` → `await pipeline(...)` → `await fh.sync()` →
   `await fh.close()`.
2. **Atomic rename**: `fs.rename` (line 51) fails with `EPERM`/`EBUSY` when the destination is open
   — which happens routinely here, because "New project" hands the file to ffprobe/the preview, and
   re-downloading a clip the editor has open is a realistic path. The repo already has the helper:
   `moveWithRetry` with EPERM backoff ([src/core/store/fs-utils.ts](src/core/store/fs-utils.ts):60).
   Use it for media finalize, not just for `state.json`.

---

## P1 — will bite during implementation

### A11. The media trust boundary accepts `http://` and includes an unjustified host

Verified against the doc's own regex `/(^|\.)(twimg\.com|x\.com)$/`
([03-tech-stack.md](03-tech-stack.md):81): `http://video.twimg.com/a.mp4` **passes** (hostname
matches, scheme never checked) — plaintext media that a size check cannot detect tampering in.

Same page, [resolver-chain.md](technical/resolver-chain.md):74 rejects adding `*.twitter.com` to the
media allow-list because "no source shows media served from `video.twitter.com` — the boundary stays
minimal". Then why is `x.com` / `*.x.com` in it? No evidence is offered for that either.

**Fix:** require `u.protocol === 'https:'` in `streamTo`; drop `x.com` from the media list unless the
D4 live matrix observes one (apply the plan's own rule to the plan). Note `api.x.com` currently
passes the media regex.

### A12. No `accept-encoding: identity` on media GETs

undici requests gzip/deflate by default and decompresses transparently, so `Content-Length` would
describe the *encoded* body and the exact-size check would raise a spurious `INTEGRITY_MISMATCH`
(and delete a perfectly good `.part`). Rare for `.mp4`, common enough with intercepting proxies and
small GIF/`animated_gif` payloads.

**Fix:** `headers: { 'accept-encoding': 'identity' }` on `streamTo`.

### A13. "Additive settings need no bump" is only half true

[ui-and-ipc.md](technical/ui-and-ipc.md):154 and [04-roadmap.md](04-roadmap.md):61 say the settings
merge handles it. Merge does ([src/core/store/settings.ts](src/core/store/settings.ts):68) — but
`normalizeSettings()` (line 105) rebuilds the object field-by-field, so a hand-edited
`downloadConcurrency: 9` would reach the typed `1|2|3` field untouched.

**Fix:** add a `downloads` block to **both** `defaultSettings()` and `normalizeSettings()`
(`oneOf`/boolean/non-empty-string per field). No schema bump needed — that part is true.

### A14. Windows path budget is unenforced

Segments are capped at 120 chars ([storage-naming.md](technical/storage-naming.md):48) with
"headroom inside 255-byte names and MAX_PATH" — but nothing caps the **total** path, and there is no
`\\?\` handling anywhere in the codebase (verified: no long-path handling in `src/`). A deep profile
+ `Videos\ShortZ\Downloads\x\<author>\<120-char name>.mp4` can exceed 260. Also note the repo's
existing sanitizer caps at **80** ([src/main/output-path.ts](src/main/output-path.ts):54), so 120 is
a new, unexplained outlier.

**Fix:** have `renderPath` enforce `root.length + segments.length ≤ 240`, truncating the *variable*
parts (author/slug) — never the id — and add a D0 table test with a 100-char root.

### A15. Two Windows sanitizers, two rule sets

The plan's sanitizer (NFC, control chars, reserved device names, trailing dots, surrogate-safe) is
stricter than the 3-line `sanitizeNamePart` in [src/main/output-path.ts](src/main/output-path.ts):14.
Because that one lives in Tier 3, `src/shared/downloader/naming.ts` cannot reuse it — so we get two
Windows rules that drift, which is exactly what [src/shared/video-extensions.ts](src/shared/video-extensions.ts)
exists to prevent ("the ONE list … keeps drift from coming back").

**Fix:** move the hardened sanitizer to `src/shared/naming.ts` and have `output-path.ts` consume it
(its callers only get stricter). One rule, both call sites.

### A16. The main plan still says "zero network", everywhere

The amendment lives only in this folder. Still unamended: [docs/01-goals.md](docs/01-goals.md):33
(G6 "No network calls in the app at all"), [docs/02-architecture.md](docs/02-architecture.md):136
("Zero network calls"), [docs/03-tech-stack.md](docs/03-tech-stack.md):83 ("No network-capable
dependency is allowed"), [docs/05-roadmap.md](docs/05-roadmap.md):78,
[docs/technical/future-extensions.md](docs/technical/future-extensions.md):21,62. A future reader (or
audit) will "fix" the downloader away.

**Fix:** five one-line edits pointing at `twitter-downloader/01-goals.md §G6′`, or one
`docs/technical/network-amendment.md` cross-linked from each. The README's "amends two statements"
count is also wrong — it's four documents.

### A17. IPC placement won't compile as sketched

`handle()` is a private function in [src/main/ipc.ts](src/main/ipc.ts):85, and the single-flight flag
`exportInFlight` lives there too (line 103) — the new `src/main/downloader.ts` can reach neither. The
`dl:start` guard must also exclude `exportInFlight` the way batch does (line 432).

**Fix:** `export function registerDownloaderIpc(deps: { handle; slots; … })` called from
`registerIpcHandlers()` ([src/main/ipc.ts](src/main/ipc.ts):232), with one small `JobSlots` object
holding `exportInFlight` / `dlInFlight` so the mutual exclusion is in one place.

### A18. `ThrottleState` as written doesn't typecheck

[download-engine.md](technical/download-engine.md):65–92 uses `this.signal` and `this.now()` but
declares neither. Also: "monotonic ms" for `pauseUntil` but an injected `now()` — a `Date.now()` clock
makes NTP steps corrupt the cooldown math.

**Fix:** `constructor(private readonly now: () => number = () => performance.now(), private readonly signal: AbortSignal)`,
and keep all arithmetic in the injected monotonic domain.

### A19. Poster cache: N requests, no eviction, wasted on dry runs

One poster per media asset, fetched during every resolve
([storage-naming.md](technical/storage-naming.md):130), cached with no eviction (unbounded growth in
`%APPDATA%`). For Analyze runs it downloads posters for rows the user never scrolls to.

**Fix:** skip when `<id>_<n>.jpg` already exists, reuse `sweepStaleDirs`
([src/core/store/fs-utils.ts](src/core/store/fs-utils.ts):115) for a 30-day sweep, and fetch lazily
for dry runs (or only under the visible window if that's easy).

### A20. DA9's "<5 s per line" isn't achievable on a dead network

Resolution is bounded by a 15 s timeout ([03-tech-stack.md](03-tech-stack.md):91), and DNS failure on
Windows routinely takes seconds; 20 failing lines through `resolveSem = 4` is minutes, not "5 s each"
([01-goals.md](01-goals.md):116).

**Fix:** either add a short connect budget (abort if no response headers within 5 s, keep the 30 s
idle budget for the body), or restate DA9 as "each line fails within 20 s; the run reports the
network error once and stays responsive".

### A21. `{index}` in the template plus the automatic `_v{index}` suffix double-counts

[storage-naming.md](technical/storage-naming.md):33–38 offers `{index}` as a template variable *and*
auto-appends `_v{index}` for index ≥ 2 → `{id}_{index}` produces `123_2_v2.mp4`.

**Fix:** append `_v{n}` only when the template didn't consume `{index}`.

### A22. Duplicate detection has two owners, and one UI state is unreachable

The renderer flags `duplicate` and does not send the line ([ui-and-ipc.md](technical/ui-and-ipc.md):41);
main dedupes again and would emit `skipped (duplicate)`
([download-engine.md](technical/download-engine.md):134) — a state the row machine lists
([ui-and-ipc.md](technical/ui-and-ipc.md):63) but the GUI can never produce.

**Fix:** one owner. Send every line with its key (A4) and let main return a verdict per key,
including `duplicate`/`multiple-links`. The renderer's parse stays a *preview* only, which is what
[ui-and-ipc.md](technical/ui-and-ipc.md):3 already claims it is.

### A23. The plan pretends there's no logging subsystem — there is one

[download-engine.md](technical/download-engine.md):169 sells `attempts`/`elapsedMs` on
`MediaOutcome` as "visibility without a logging subsystem (xdl's reason for deleting theirs)". This
repo ships [src/core/log.ts](src/core/log.ts) with a file sink installed by the main process
(`main.log`, the packaged-build support artifact).

**Fix:** log resolve/download failures through `logWarn`/`logInfo` (URL sanitized, no cookies — there
are none) in addition to the per-item outcome fields. Support for "why did last night fail" should
not require the user to hover a tooltip.

### A24. A proxy is the most likely "NETWORK" failure on a Windows desktop

[03-tech-stack.md](03-tech-stack.md):67 defers `net.fetch`/proxy support to the parking lot, correctly
(preserving the undici test seam is worth more). But undici ignores system proxies, so on a proxied
or TLS-intercepting machine every request fails as `NETWORK` while the user's browser works fine.

**Fix:** keep undici; on a `NETWORK` verdict, call `session.defaultSession.resolveProxy(url)` once and
append "a system proxy is configured — ShortZ doesn't use it yet" to the error detail. Two lines,
turns the worst support ticket into a self-explaining message.

---

## What checks out (verified in this repo, not taken on faith)

| Plan claim | Evidence |
|---|---|
| `media://` already serves JPEG/PNG, so posters can ride it | `MIME_BY_EXT` has `.jpg/.jpeg/.png` — [src/main/protocol/media.ts](src/main/protocol/media.ts):24 |
| `getMediaUrl` rejects posters (video-only validation), so main must mint directly | `getMediaUrlForFile` → `isVideoExtension` — [src/main/protocol/media.ts](src/main/protocol/media.ts):71 |
| `mintMediaUrl` exists and is main-only | [src/main/protocol/media.ts](src/main/protocol/media.ts):61 |
| "New project" reuses `createProject`, no copy, no new import path | references the source, ffprobes, generates thumb — [src/main/ipc.ts](src/main/ipc.ts):235 |
| Electron 33 / Node 20.18 / `AbortSignal.any` / `Readable.fromWeb` all available | `electron ^33.3.1` — [package.json](package.json):34 |
| JSON state + atomic writes, EPERM retry helper exists | `atomicWriteFile`, `moveWithRetry` — [src/core/store/fs-utils.ts](src/core/store/fs-utils.ts):60,81 |
| Data dir / portable mode as described (`%APPDATA%\shortz`, `.\data\`) | [src/core/store/settings.ts](src/core/store/settings.ts):26, [src/main/data.ts](src/main/data.ts):22 |
| Settings additive without a schema bump | merge + `normalizeSettings` — [src/core/store/settings.ts](src/core/store/settings.ts):52 (but see A13) |
| Fourth screen + `onOpenBatch` idiom | `type Screen = 'home' \| 'editor' \| 'batch'` — [src/renderer/src/App.tsx](src/renderer/src/App.tsx):14 |
| Single-flight export slot to mirror | `exportInFlight` — [src/main/ipc.ts](src/main/ipc.ts):103 |
| DA10 hostile-host rejection | ran the doc's regexes: `evil.example/x.com/…`, `x.com.evil.example/…`, `max.com/x.com/…` all rejected; `evil-twimg.com` and `twimg.com.evil.example` fail the media test |
| Bundle ffmpeg available for D5 | `ffmpeg-static` + `ffprobe-static` — [package.json](package.json):22 |

---

## Suggested order of work

1. **Docs only (a few hours):** A1 (fold rule + copy + DA2/DA7), A2 (regenerate goldens), A3 (vendor
   or inline the reference decisions), A4/A5/A6/A7/A8 (rewrite the IPC + state + cancel contracts),
   A16 (amend the main docs). None of this needs code.
2. **D0** with corrected goldens and the A14/A15 naming decisions baked in.
3. **D1**, and use it to settle A1's disambiguation probe and A11's allow-list against a real matrix
   before the boundary is frozen into D2.
4. **D2** with A9/A10/A12 in the engine from the first commit — retrofitting `If-Range` and fsync
   after resume "works" means re-testing everything.
