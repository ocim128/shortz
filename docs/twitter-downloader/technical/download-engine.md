# Technical — Download Engine (streaming, resume, pacing, containment)

Port of xdl `engine/{downloader,throttle}.py` + the orchestrator's resilience layer, into `src/core/downloader/{engine/orchestrator}`. Node 20 APIs only.

## 1. `fetchToFile` — one variant, one file

```ts
// src/core/downloader/engine/fetch.ts (shape)
export interface FetchCtx {
  client: DlClient            // allow-listed wrapper (see 03-tech-stack.md)
  throttle: ThrottleState
  signal: AbortSignal         // composed: run signal + per-item signal
  onProgress: (delta: number, total: number | null) => void
}

export async function fetchToFile(url: string, dest: string, ctx: FetchCtx): Promise<number>
```

Flow (every step from xdl's `fetch`, which survived three audit rounds):

1. **Trust boundary first** — `isAllowedMediaUrl(url)` (dot-anchored `*.twimg.com` — media list is twimg-only since rev 3) **and `https:` enforced**, else `URL_UNRECOGNIZED`. Already checked in the client; re-checked here. A hostile URL never reaches a socket even if a future caller forgets.
2. **Resume probe** — if `<dest>.part` exists, `offset = stat().size`; send `Range: bytes=<offset>-`. When the expected total is already known (state `sizeBytes`) and `offset === total`, skip the request entirely and go straight to verify + rename (audit rev 2 — the interrupted-at-100% case).
3. **Pacing** — `await throttle.gate()` before the request so resolve and download share one policy. Media GETs send `accept-encoding: identity` (rev 3: undici's transparent gzip would make `Content-Length` describe the *encoded* body) and capture the response's `ETag`/`Last-Modified` for the validator sidecar (step 7).
4. **Status handling:**

| Response | Action |
|---|---|
| `429` | `throttle.report429(retryAfter)` (global pause) + raise `RATE_LIMITED` |
| `403` | raise `LINK_EXPIRED` — signed URL expired; orchestrator re-resolves once |
| `206` | total = tail of `Content-Range: bytes s-e/TOTAL` (authoritative; `Content-Length` here is only the *remaining* bytes) |
| `200` **after a ranged request** | server ignored Range → **restart from zero** (truncate), never append a mismatch |
| `416` Range Not Satisfiable | read `Content-Range: bytes */<total>`; `offset === total` → the `.part` is already complete, skip to verify + rename; otherwise the `.part` is junk → delete, restart without Range (audit rev 2) |
| `200` (no range) | total = `Content-Length` or `null` (chunked/unknown) |
| `404` / `401` / `5xx` | `NOT_FOUND` / `AUTH_REQUIRED` / `UPSTREAM_ERROR` |
| timeout | `NETWORK`; transport error | `NETWORK` |
| `ENOSPC` on write | `DISK_FULL`; other FS error | `WRITE_ERROR` |

5. **Streaming write** — the open mode is decided *after* the status is known (audit rev 2: `'r+'` without `start` writes at byte 0 and would overwrite the first N bytes instead of resuming), and the fsync needs the *same* handle (rev 3: `pipeline` + `createWriteStream` alone never exposes one):

```ts
const fh = await fsp.open(part, resume ? 'r+' : 'w')
try {
  await pipeline(
    Readable.fromWeb(res.body),
    fh.createWriteStream({ start: resume ? offset : 0, autoClose: false })
  )
  await fh.sync()          // the rename is only as durable as the flush before it
} finally {
  await fh.close()
}
```

with the abort signal composed in; on abort, the current chunk boundary is the stop point and **the `.part` is kept** for resume. A `200` answer to a ranged request lands here as `resume = false` → `'w'` truncates — the restart-from-zero rule falls out of the same branch. Progress callback per chunk (64 KiB), coalesced upstream.
6. **Integrity** — when `total` is known and `size !== total`: delete the `.part`, raise `INTEGRITY_MISMATCH`. When `total` is unknown: a clean stream end + rename *is* the integrity bar (no false mismatch — xdl rule).
7. **Validator sidecar (rev 3 — same-size corruption must not pass):** the first response's `ETag`/`Last-Modified` and the known total persist beside the partial as `<name>.mp4.part.json` (`{ etag, lastModified, total }`); every resume request carries `If-Range: <validator>` — the server answers `206` only if the object is unchanged, and a `200` means *object changed* → truncate and restart. This retires the "stale `.part` from an older encoding" case by construction; the size check stays as belt-and-braces.
8. **Atomic finalize** — `moveWithRetry(part, dest)` from `core/store/fs-utils` (rev 3: plain `fs.rename` fails `EPERM`/`EBUSY` exactly when "New project" has ffprobe or the preview holding the destination). Same volume, atomic; the destination never exists in a half-written state.

Result: the number of bytes written (for the state row and the summary).

### Why `.part` survives cancel and crash

The `.part` file is the unit of resume, independent of state: on the next run the orchestrator resolves the same variant URL family, and if the fresh URL points at the same object (size from a HEAD-less probe is not assumed — the Range request itself answers), transfer continues from `offset`. If the CDN hands back `200` (Range refused), the restart-from-zero rule keeps correctness. A stale `.part` from an *older, different* encoding can only produce an `INTEGRITY_MISMATCH`, which deletes the `.part` and retries clean — self-healing by design.

## 2. `ThrottleState` — pacing with one shared brain

Port of xdl `engine/throttle.py`, including the subtlety that makes it correct under concurrency:

```ts
// src/core/downloader/engine/throttle.ts (shape)
export class ThrottleState {
  // rev 3: the clock is injected AND monotonic — performance.now(), never
  // Date.now() (an NTP step would corrupt the cooldown math); the abort signal
  // is a declared field, not an implicit global.
  constructor(
    private readonly now: () => number = () => performance.now(),
    private readonly signal?: AbortSignal
  ) {}

  private minGap: number          // jittered 0.2–0.5 s at construction (or settings floor)
  private pauseUntil = 0          // monotonic ms, in this.now()'s domain
  private lastRequest = 0
  private recent429: number[] = []

  async gate(): Promise<void> {
    // Wake-and-recheck loop (audit rev 2): callers already sleeping inside
    // gate() when a 429 lands must NOT fire inside the cooldown — they would
    // collect fresh 429s and falsely trip the 3-in-60 s escalation to 120 s.
    for (;;) {
      const now = this.now()
      if (now < this.pauseUntil) {
        await sleep(this.pauseUntil - now, this.signal)
        continue
      }
      // SLOT RESERVATION: advance lastRequest to the slot THIS caller will
      // occupy, before any await (no await between the read and the write) —
      // concurrent callers queue behind each other instead of bursting.
      const slot = Math.max(now, this.lastRequest + this.minGap)
      this.lastRequest = slot
      if (slot > now) {
        await sleep(slot - now, this.signal)
        if (this.now() < this.pauseUntil) continue   // a 429 landed mid-sleep
      }
      return
    }
  }

  report429(retryAfterHeader?: string | null): void {
    this.reportPause(parseRetryAfter(retryAfterHeader) ?? 30_000)
  }

  reportPause(ms: number): void {
    const now = this.now()
    this.recent429 = this.recent429.filter((t) => now - t < 60_000)
    this.recent429.push(now)
    let pause = Math.max(ms, 30_000)
    if (this.recent429.length >= 3) pause = Math.max(pause * 2, 120_000)  // escalation
    this.pauseUntil = Math.max(this.pauseUntil, now + pause)
    // Callers already queued in gate() must not slot themselves into the
    // cooldown we just set.
    this.lastRequest = Math.max(this.lastRequest, this.pauseUntil)
  }
}
```

- **One worker's 429 pauses everyone** — resolve and download share the instance (xdl: "global 429 pause").
- `parseRetryAfter`: seconds (int/float) or HTTP-date; invalid/absent → 30 s floor.
- **The wake-and-recheck loop is an audit fix that hardens the reference implementation too**: xdl's `gate()` computes its slot once, so callers already sleeping when a 429 lands still fire inside the cooldown — collecting fresh 429s and falsely tripping the escalation. The burst test pins the fix: a 429 landing while 6 callers sleep → zero requests leave before the pause lifts, at most one escalation.
- The no-`await`-between rule is a property of the event loop, identical in Python-asyncio and Node — the port keeps it and the burst test (8 concurrent gates under a fake clock → strictly serialized slots) pins it.

## 3. Orchestrator — batch semantics

```ts
// src/core/downloader/orchestrator.ts (shape)
export interface RunDeps {
  client: DlClient
  chain: FallbackChain
  throttle: ThrottleState
  state: StateStore
  signal: AbortSignal
  onEvent: (e: DlEvent) => void
  clock?: () => number
}

export async function runDl(req: DlRunRequest, deps: RunDeps): Promise<DlRunSummary>
```

- **Normalize (one verdict owner, rev 3):** every line arrives from the renderer as `{ key, lineNumber, text }` — duplicates and junk included; the renderer's parse is a *preview only*. Main parses again, maps `text → TweetRef` (t.co expansion is the one network hop, throttled), and returns a **verdict per key**: later duplicates become `skipped (duplicate)`, junk lines fail typed — no line is ever dropped, so row mapping cannot shift.
- **Pre-skip before any resolve** (audit rev 2): the `tweetId` is known synchronously for every direct status URL, so the orchestrator checks the state index *first* — complete (ok rows == `mediaCount`, files stat) → item `skipped` with **zero network I/O**. Offline re-runs (DU8) and deleted-after-download re-runs stay idempotent; `force` bypasses. A `t.co` input pays only its single expansion hop before the id is known.
- **Two independent semaphores** (xdl D23 — do not merge):

```
resolveSem = 4        downloadSem = 3        (settings ranges 1–5 / 1–3)
```

  Per item: `_prepare` (resolve → select → planned paths) holds a **resolve** slot only; per chosen variant: `_download` holds a **download** slot only. Later resolves overlap earlier transfers; a transfer stalled in a 429 cooldown never occupies a resolve slot. (xdl learned this the hard way: nesting collapsed effective resolve parallelism to `resolve − download` and one regression test now guards it.)
- **Bounded lookahead** (audit rev 2): resolve takes ~200 ms, a download 10–60 s — resolving a 100-item batch unbounded burns syndication rate limit and lets the earliest signed URLs expire before their download slot arrives (a cascade of 403 `LINK_EXPIRED`). An item enters `resolveSem` only while `pendingDownloads < downloadConcurrency × 2` (K = 6 at defaults): the transfer queue stays fed and resolve never runs more than one screen ahead.
- **Completeness rule** — used by the pre-skip above (and after re-resolve when the id was only known via `t.co`): `okRows(tweetId).length === mediaCount` **and** every `filePath` stats as a file. Never "any row exists" — a multi-video post with one failed video is *incomplete* and its ok rows do not skip (mediaCount counts video/gif assets only; a photo-only post writes no tweet row — xdl D9).
- **Re-finalize** — file + sidecar on disk, no/partial state row (crash window): write the row, no re-download.
- **Item containment** (xdl D27 — a batch of 500 must not die on one malformed post):

```ts
try { …prepare + download… }
catch (e) {
  if (e instanceof DlError) verdict = { status: 'failed', error: e }
  else verdict = { status: 'failed', error: new DlError('UNEXPECTED', String(e)) }
}
// AbortError is rethrown here and caught ONCE at the run boundary (rev 3):
// in-flight items end 'cancelled' and the run still emits its terminal event.
```

- **Circuit breaker** — 8 consecutive failed/partial items → open; remaining unstarted items become `skipped (circuit open)` (recorded incomplete only when the tweet has no download rows); the summary carries one line "stopped after 8 consecutive failures — Retry failed to continue".
- **Cancel (contract, rev 3):** `signal.abort()` between items stops scheduling; mid-transfer it raises at the next chunk boundary (`.part` retained). `AbortError` is caught at the **run** boundary: in-flight items end `cancelled` and **exactly one `run-done` event is emitted per run — always** — with the summary marked `cancelled`. That single guarantee is what clears `dlInFlight`, renders the UI's `cancelled` chip, and makes the CLI's exit 130 possible.
- **Events** — lifecycle per item (`item-start`, `item-skip`, `item-resolve-done`, `media-start`, `media-progress`, `media-done`, `item-done`, `run-done`) carry `(jobId, lineIndex, tweetId, mediaIndex, status, bytes, total, error?)`; main coalesces `media-progress` to ~10 Hz and forwards everything else immediately.

## 4. Retry schedule (orchestrator-owned)

| Trigger | Action |
|---|---|
| `NETWORK` / `UPSTREAM_ERROR` / `RATE_LIMITED` | retry up to 3 attempts total; backoff 1 s → 4 s → 15 s, ±20% jitter; 429 additionally obeys the global pause |
| `LINK_EXPIRED` (403 on media) | exactly **one** re-resolve (fresh signed URL), then Range-resume the `.part` |
| `INTEGRITY_MISMATCH` | exactly **one** clean restart (`.part` deleted) |
| everything else | no retry — the verdict is final for the run |
| attempts/wall-time | recorded on `MediaOutcome` (`attempts`, `elapsedMs`) and surfaced in the row tooltip; **failures additionally log through the existing `core/log` file sink** (`logWarn`, URL sanitized — there are no cookies) so "why did last night fail" never requires hovering a tooltip (rev 3) |
| proxy awareness (main) | a `NETWORK` verdict triggers one `session.defaultSession.resolveProxy(url)` check; with a proxy configured, the error detail gains "a system proxy is configured — ShortZ doesn't use it yet" (rev 3; the orchestrator stays Electron-free — main owns the enrichment) |

## 5. What is deliberately absent

- **No worker threads.** Async I/O saturates long before a thread pool would help; the single-threaded loop *is* the throttle's correctness model.
- **No per-request proxy config** — Node fetch ignores env/system proxies; the mitigation is the self-explaining `NETWORK` hint above (rev 3), and a `net.fetch` switch stays in the parking lot.
- **No request coalescing/dedup of variant URLs** — dedup happens at the tweet level; two variants of one post are two legitimate files (`_v2`).
- **No checksum sidecar** — exact-size verification + Range resume already bound the failure modes xdl considered (`--checksum` was built and deliberately removed there).
