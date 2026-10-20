# ShortZ — Twitter/X Video Downloader (Feature Plan)

**Feature:** paste X (Twitter) status links → download the video(s) → edit → post, without leaving ShortZ.
**Status:** Planning — **Rev 2** (nothing implemented yet; external audit applied — see Revision history at the bottom).
**Scope owner:** this folder. The main app plan stays in [`../README.md`](../README.md).
**Reference implementation (prior art, not shipped code):** `../downloader` (the `xdl` Python package, M0–M6 shipped). This plan ports its *design*, not its code — see [`03-tech-stack.md`](03-tech-stack.md) for why.

## The one-paragraph version

ShortZ already turns a local clip into a vertical video. The missing first step is getting the clip. Today the user leaves the app, uses a download site, drags the file back in. This feature adds a **Downloader screen**: paste one or many `x.com/<user>/status/<id>` links (one per line — the batch case is the normal case), ShortZ resolves each post through a fallback chain (`cdn.syndication.twimg.com` first, optionally `api.fxtwitter.com`, optionally a local `yt-dlp` sidecar), downloads the best progressive MP4 with `.part`/Range resume and integrity checks, writes a metadata sidecar, and records state so a re-run **skips** what already exists. Each finished download is one click from becoming an editor project.

## Core decisions (short version)

| Decision | Choice | Why |
|---|---|---|
| Language / program | **TypeScript port of xdl's architecture inside ShortZ** — not a Python sidecar, not yt-dlp-driven | One runtime, one test harness, and the syndication token algorithm is *natively exact* in V8 (xdl needed a byte-exact V8 emulation in Python — `((Number(id)/1e15)*Math.PI).toString(36).replace(/(0+\|\.)/g,'')` is a one-liner here) |
| Where the code lives | `src/shared/downloader` (pure) + `src/core/downloader` (Node, Electron-free) + thin `src/main` glue | Follows ShortZ's existing purity tiers; the whole engine is unit-testable without Electron |
| Resolver chain | syndication → fxtwitter (opt-in) → yt-dlp sidecar (opt-in, later) | Matches xdl's proven order; every adapter failure falls through, so "not embeddable" never reads as "post deleted" |
| Media download | Node 20 `fetch` + `.part` temp + Range resume + exact-size verify + atomic rename | The xdl engine rules port 1:1; Node's f64/streams make it straightforward |
| State | **JSON index** (`downloads/state.json`) + per-file `.meta.json` sidecars | ShortZ stores everything as JSON already; personal scale (10³–10⁴ rows) needs no SQLite. Upgrade path documented |
| Batch UX | Textarea, one status URL per line, `#` comments, blanks ignored, duplicates flagged | Mirrors the existing Batch screen (`path•hook` lines) the user already knows |
| Network posture | **The Downloader is the only networked feature**; user action only; host allow-list enforced in one client wrapper; no cookies, no telemetry | Amends G6 of the main plan honestly instead of pretending it still holds |
| UI placement | Fourth screen, `home | editor | batch | downloader`, entered from Home like Batch | Same navigation idiom; no new window, no modal maze |

## Document map

| Doc | What's inside |
|---|---|
| [01-goals.md](01-goals.md) | Problem, goals, non-goals, user stories, MVP definition, acceptance tests |
| [02-architecture.md](02-architecture.md) | Whole infrastructure: components, data flow, process/concurrency model, storage, network posture, failure handling |
| [03-tech-stack.md](03-tech-stack.md) | Code/program choices with alternatives compared: TS port vs Python sidecar vs yt-dlp-driven; HTTP client; state store; testing |
| [04-roadmap.md](04-roadmap.md) | Milestones D0 → D5 with tasks and done-criteria, risk register, deliberately-not-built list |

### Technical sub-documents (`technical/`)

| Doc | What's inside |
|---|---|
| [technical/resolver-chain.md](technical/resolver-chain.md) | URL grammar (every X link form), canonicalization, the syndication token algorithm + TS code, payload→model mapping, fxtwitter adapter, yt-dlp sidecar adapter, fallback semantics, error taxonomy |
| [technical/download-engine.md](technical/download-engine.md) | Streaming download: `.part`/Range/resume, integrity, atomic rename, throttle + global 429 pause, retry/backoff, circuit breaker, cancel, the two-semaphore concurrency model |
| [technical/storage-naming.md](technical/storage-naming.md) | Deterministic Windows-safe paths, sidecar schema, state index schema, skip/retry/completeness semantics, crash-safe write order |
| [technical/ui-and-ipc.md](technical/ui-and-ipc.md) | Downloader screen spec, line-parser rules, settings additions (exact TS types), IPC channels + wire types, event/progress model, renderer store |

## Reading order

1. [`01-goals.md`](01-goals.md) — what this feature is and, more importantly, what it refuses to be.
2. [`02-architecture.md`](02-architecture.md) — how it plugs into ShortZ without breaking the tiers.
3. [`technical/resolver-chain.md`](technical/resolver-chain.md) — the risky part; read before estimating.
4. [`03-tech-stack.md`](03-tech-stack.md) + [`04-roadmap.md`](04-roadmap.md) — with what, in what order.
5. [`technical/download-engine.md`](technical/download-engine.md), [`technical/storage-naming.md`](technical/storage-naming.md), [`technical/ui-and-ipc.md`](technical/ui-and-ipc.md) — when implementation starts.

## Relationship to the existing plan

This feature **amends** two statements in the main docs, and the amendment is deliberate:

1. `03-tech-stack.md` §"Dependency policy" says *"No network-capable dependency is allowed"*. The downloader needs network. The rule becomes: **network code exists only in `src/core/downloader` behind one allow-listed client; no network-capable *dependency* is added** (Node's built-in `fetch` is not a dependency). The renderer still performs zero network I/O.
2. `02-architecture.md` §"Security posture" says *"Zero network calls"*. It becomes: **zero unprompted network**; the downloader runs only on explicit user action, talks only to documented hosts, never sends cookies or credentials, and the app remains fully functional offline.

## Revision history

- **Rev 2 — external audit applied (13 findings):** scheme-less URL parsing with a hostile-host boundary rule (1); resume write via `flags` + `start` so `'r+'` can never overwrite the `.part` head (2); throttle wake-and-recheck loop + `lastRequest` advance on pause — sleeping callers can neither fire inside a 429 cooldown nor falsely trip escalation (3; hardens the reference implementation too); state **pre-skip before any network** for offline idempotence (4); HTTP `416` → finalize-or-restart (5); posters ride progress/list events as ready `media://` URLs minted by main (6 — the `media://` handler already serves JPEG/PNG; what rejects posters is `getMediaUrl`, so main mints directly); **bounded resolve lookahead** `K = 2× downloadConcurrency` against rate-limit burn and signed-URL expiry (7); Analyze unified with `dlStart({ dryRun: true })` — streaming, cancellable (8); `dlList` bounded to the newest 100 entries (9); `NOT_EMBEDDABLE` rows get an enable-fallback hint (10); media allow-list keeps out `*.twitter.com` — checked against evidence, not adopted (11); `select()` deterministic under null/0 bitrates via pixel-area fallback (12); textarea frozen during runs with row snapshot at start (13).
- **Rev 1:** initial plan.

`01-goals.md` G6 ("Runs fully offline, zero accounts, zero telemetry") is restated as G6′ in this folder's goals doc.
