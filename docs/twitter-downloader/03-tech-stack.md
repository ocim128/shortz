# 03 — Tech Stack & Program Choices

## Summary table

| Layer | Choice | Why |
|---|---|---|
| Language | **TypeScript everywhere** (shared + core + main + CLI) — no second runtime | The token algorithm is V8-native; one test harness; the editor hand-off is a function call, not an IPC to another process |
| HTTP client | **Node's built-in `fetch`** (undici, Electron 33 = Node 20) behind one injectable wrapper | Zero new dependencies; streaming bodies; `AbortSignal`; undici semantics match the hermetic-test seam |
| File streaming | `Readable.fromWeb(res.body)` → `fs.createWriteStream` via `stream.promises.pipeline` | Backpressure for free; abort-aware; no manual chunk plumbing |
| Resolver #1 | `cdn.syndication.twimg.com` + react-tweet token (pure TS, one line) | No account, no key; the exact endpoint Vercel's react-tweet ships to millions of pages |
| Resolver #2 | `api.fxtwitter.com` (**opt-in**) | Third-party service; resilience, not default surface |
| Resolver #3 | `yt-dlp` sidecar `.exe` (**opt-in**, D5, resolve-only via `-J`) | The maintenance safety net when X changes something; never drives our downloads |
| State | **JSON** (`downloads/state.json`, atomic writes) | Matches ShortZ's storage idiom; no native dep; personal scale |
| Concurrency | Plain `Promise` + two counting semaphores (no worker pool) | Event-loop single-threading is the correctness guarantee (throttle slot trick); xdl proved the shape |
| Testing | Vitest + injected `fetchImpl` + recorded JSON fixtures + golden token tests | Hermetic by default; live checks opt-in via `LIVE_DL=1` |
| Packaging | Nothing new bundled in v1; optional `yt-dlp.exe` sidecar fetched on user demand (D5) | Keeps the installer lean; mirrors the whisper-model opt-in precedent |
| New runtime dependencies | **Zero** | Everything needed is in Node 20/Electron 33 today |

## The program fork — what we actually build

Three credible ways to get "paste link → MP4" inside ShortZ:

### Option A — Port xdl's architecture to TypeScript inside ShortZ ✅ **Chosen**

Re-implement the ~1.5 kLOC of essential xdl logic (urls, token, chain, engine, storage, orchestrator) in the existing tiers.

| Pros | Cons |
|---|---|
| One language, one test runner, one packaging story | A rewrite, not a copy (~1–2 weeks with AI assist — see roadmap) |
| **Token algorithm is natively exact**: `((Number(id)/1e15)*Math.PI).toString(36).replace(/(0+|\.)/g,'')` runs on the same V8 that react-tweet targets. xdl needed a 150-line Dragon-fraction emulation to match `Number.prototype.toString(36)`; here it is one line and *cannot drift* | Syndication payload drift must be caught by our own fixture tests (xdl already proves the mapping is stable) |
| Download → editor hand-off is a plain call into existing `createProject` code | — |
| Zero new runtime dependencies; nothing to audit for supply-chain | — |
| The engine rules xdl battle-tested (.part/resume/verify/throttle/containment) port mechanically — the design is *proven*, only the language changes | — |

### Option B — Bundle xdl as a Python sidecar ❌ Rejected

`xdl.exe` (PyInstaller) or an embedded Python, spawned per batch, results parsed from JSON/exit codes.

| Pros | Cons |
|---|---|
| Zero rewrite — xdl is shipped and hardened (M0–M6) | Two runtimes to build, sign, and keep current; ~30–80 MB installer bloat |
| | xdl is a private repo with no release channel; every ShortZ user update must drag a Python tool update |
| | Windows + Python + PyInstaller = AV false-positive roulette on a machine that today ships only signed Electron artifacts |
| | Error/progress surface crosses a process boundary (stdout protocol) — exactly the fragility xdl's web UI avoided by importing the core as a library |
| | Two test matrices forever (Python hermetic suite AND the bridge) |

### Option C — yt-dlp-driven ❌ Rejected (kept as thin fallback only)

Spawn `yt-dlp.exe` for everything; parse its JSON; skip writing a resolver.

| Pros | Cons |
|---|---|
| Least code today | Signs ShortZ up for *someone else's release cadence*: a broken X extractor days after a yt-dlp release breaks the feature with no local fix |
| | Naming/dedup/skip/sidecars all live in yt-dlp's output templates — no deterministic `by-author/<id>` state model without re-implementing it anyway |
| | Bundling or downloading a 17 MB binary becomes a hard install requirement instead of an opt-in safety net |
| | xdl's decision #2 exists precisely because of this: **resolve-only yt-dlp, our engine downloads** — same conclusion here |

**Verdict:** A, with C's binary as the opt-in Adapter D in D5 and B's repo as the design reference. The port is bounded work because the hard thinking (fallback semantics, throttle, containment, naming) is already done and documented in xdl's `DECISIONS.md`, which this plan cites decision-by-decision.

## HTTP client: the details

| Candidate | Verdict |
|---|---|
| **Node built-in `fetch`** (undici) | **Chosen.** Present in Electron's main process (Node 20.18). Streaming `Response.body` (web stream) → `Readable.fromWeb`. `AbortSignal` composition. Manual redirects. No dependency. |
| `got` | Rejected: heavy stream API, a dependency where none is needed, HTTP/2 support drags in more |
| `axios` | Rejected: buffers by default (we need streaming), Node-stream ergonomics are worse, no benefit |
| Electron `net.fetch` | Rejected for v1: Chromium-stack (proxy/HTTP2) is nice-to-have, but it bypasses the undici test seam and its proxy behavior differs from plain `fetch`. Revisit only if corporate-proxy users appear (parking lot) |
| `http.request` raw | Rejected: undici exists so nobody writes this again |

Wrapper rules (enforced in code, ~80 lines):

```ts
// src/core/downloader/net/client.ts (shape)
export interface HttpDeps {
  /** Injectable for hermetic tests; defaults to globalThis.fetch. */
  fetchImpl?: typeof fetch
  now?: () => number            // injected clock for throttle tests
}

const RESOLVE_HOSTS = new Set(['cdn.syndication.twimg.com', 'api.fxtwitter.com', 't.co', 'x.com', 'twitter.com'])
const MEDIA_HOST_RE = /(^|\.)(twimg\.com|x\.com)$/   // exact-suffix, dot-anchored

export function createDlClient(deps: HttpDeps): DlClient
//   getJson(url, { signal }): Promise<unknown>      — allow-list: RESOLVE_HOSTS (fxtwitter only when enabled)
//   expandTco(url, { signal }): Promise<string>     — redirect:'manual', reads Location, result re-parsed by urls.ts
//   streamTo(url, dest, { signal, offset }): ...    — allow-list: MEDIA_HOST_RE; returns verified size
```

- `evil-twimg.com` fails `MEDIA_HOST_RE` (the dot anchor), `https://x.com.evil.example/...` fails too. Unit-tested with a hostile-URL matrix (DA10).
- **`*.twitter.com` stays out of the media allow-list (rev 2):** the resolver-host set includes `twitter.com` for redirects/landing pages, but media evidence points only at `*.twimg.com` (`video`, `pbs`, `ton`). Widening a trust boundary needs a recorded fixture, not a hunch — the D4 live matrix is the gate.
- Timeouts: `AbortSignal.any([jobSignal, AbortSignal.timeout(ms)])` — resolve 15 s, media idle 30 s (idle = per-read stall, not total — big files on slow lines must not die at 30 s total; implemented by wrapping the body reader).

## State store: JSON vs the alternatives

| Candidate | Verdict |
|---|---|
| **Single JSON doc** (`state.json`, `Map` in memory, atomic flush) | **Chosen.** Same idiom as projects/settings; atomic write helper already exists (`core/store/fs-utils.ts`); 10⁴ rows ≈ 1–2 MB — irrelevant on disk, parsed in < 50 ms |
| `better-sqlite3` | The documented **upgrade path**, not the start: native module → electron rebuild step, ABI pinning, installer weight — all to index a file a human will never grep. Trigger to revisit: > 50 k rows or visible write stalls |
| JSONL append log | Rejected: needs compaction logic (a second file + rotation) to avoid unbounded growth — more code than the JSON flush it would replace |
| Derive state from sidecars only | Rejected as *primary* (xdl needs `mediaCount` to answer "complete?" without re-resolving); kept as the **recovery** path: "file + sidecar exist, no row" is normalized on next run, no re-download |

Flush discipline: state mutations happen at item boundaries (resolve done, media done, verdict); the orchestrator flushes once per mutation via the atomic helper — a handful of writes per item, not per tick. Crash between media rename and state write is *safe by design*: the re-finalize rule above repairs it for free.

## Quality selection (the only "smarts" users see)

- Default `best` = highest `bitrate` among `video/mp4` variants (syndication always carries a progressive MP4 ladder; 320/640/832/1280/2178 kbps classes are typical).
- `worst` = lowest bitrate MP4.
- `maxHeight: 720` = closest fit **above** the cap when none is under it — never an error (xdl decision #5); ties resolved toward the higher bitrate.
- HLS (`application/x-mpegURL`) variants are ignored **while a progressive MP4 exists**; if the chosen payload is HLS-only (possible via yt-dlp), the download remuxes through the already-bundled ffmpeg — D5 scope.
- GIF posts: X serves silent looping MP4s; downloaded as-is by default (real GIF conversion via ffmpeg palettegen = D5 toggle).

Scoring stays deterministic even when the ladder lies (audit rev 2 — `null` from fxtwitter and `0` on some GIF variants make `b.bitrate - a.bitrate` yield `NaN`, leaving V8's sort order implementation-defined):

```ts
// src/shared/downloader/select.ts — never NaN
function variantScore(v: Variant): number {
  if (v.bitrate != null && v.bitrate > 0) return v.bitrate
  return (v.width ?? 0) * (v.height ?? 0)      // pixel-area fallback
}
// 'best' = max score; ties → higher pixel area → lexicographic URL compare.
```

## Testing strategy

| Layer | What | How |
|---|---|---|
| `urls.ts` | Every link form ×15, hostile hosts, embedded-in-text, invalid ids | Vitest table tests; cases ported from xdl's suite |
| `token.ts` | Byte-exactness | **Golden tests: the 17 Node-computed tokens from xdl's `test_token.py`** (`"20" → "6dq1a2xwd9"`), plus a 3 000-id differential test in CI-light mode against recorded vectors |
| `select.ts` / `naming.ts` | Policy + sanitizer | Pure tables: bitrate ties, cap-above-fit, reserved names, control chars, 19-digit ids, surrogates |
| Resolvers | Payload mapping, error codes | Injected `fetchImpl` returning recorded JSON fixtures (`tests/fixtures/syndication/*.json`); a `scripts/record-dl-fixture.ts` re-records live payloads (never committed with real captions unless the user opts in) |
| Chain | Fall-through + terminal-error folding | Table tests per xdl's semantics |
| Engine | Resume, integrity, 429, cancel, ENOSPC | In-memory `fetchImpl` + temp dirs: Range honored/ignored (200 restart), truncated body → `INTEGRITY_MISMATCH`, `AbortController` mid-stream keeps `.part`, `ENOSPC` → `DISK_FULL` |
| Throttle | Slot reservation, global pause, escalation | Injected clock; assert no burst under 8 concurrent gates |
| Orchestrator | Batch semantics | Fake chain + fake engine: partial multi-video, skip completeness, circuit breaker at 8, cancel drain |
| GUI/E2E | Downloader screen happy path + cancel | Existing CDP harness (`e2e/run.mjs`) with a `SHORTZ_DL_FIXTURE` env that swaps the client for the fixture impl — the GUI is tested without network |
| Live (opt-in) | `LIVE_DL=1 pnpm test` | One real syndication call + one real small-video download; skipped by default, same philosophy as xdl's `-m live` |

## Version & compatibility targets

| Component | Target | Note |
|---|---|---|
| Electron | 33 (current) | Node 20.18 in main: `fetch`, `AbortSignal.any`, `Readable.fromWeb` all present |
| TypeScript | 5.x strict | New files join the existing tier tsconfigs; `strict: true` from day one |
| Node streams | web → node adapters | No manual `for await` over bytes in production paths (tests may) |
| `yt-dlp.exe` (D5) | Pinned release + SHA-256, staleness badge at 14 days | Port of xdl's `stale_ytdlp_warning` |

## Dependency policy amendment (the one the main plan needs)

Main plan: *"No network-capable dependency is allowed."* Amended, enforced by review:

1. **No new dependency, runtime or dev, is required by this feature.** (`fetch`, streams, `AbortSignal` are platform.)
2. Network code exists **only** in `src/core/downloader/net/client.ts`; a lint pass greps `fetch(` / `http.request` outside it (CI-light: `rg` in a script test).
3. The optional `yt-dlp.exe` sidecar is **data, not a dependency**: user-triggered download, pinned hash, stored in the data dir, spawnable, deletable.
