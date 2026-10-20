# 04 — Roadmap

Same conventions as the main plan: milestones are strictly stacked, each ends with something usable, estimates assume solo work with AI assistance (~1–2 h/evening).

The GUI-less-first order is deliberate: D0–D2 build the whole pipeline under Vitest and the CLI with no screen to hide behind — exactly how the render engine was built (M1 before M2).

## D0 — Pure foundation (≈ 1–2 days)

**Goal:** every deterministic rule exists, tested, with no network and no Electron.

- [ ] `src/shared/downloader/types.ts` — `TweetRef`, `Variant`, `MediaAsset`, `ResolvedTweet`, `Chosen`, `ItemResult`, `DlRunSummary`, `DlEvent`.
- [ ] `src/shared/downloader/errors.ts` — `DlErrorCode` union + `retryable(code)` + user-facing message map keys (strings added later).
- [ ] `urls.ts` — the full grammar (status, `/i/web/status`, intent, embed, mirrors, bare-id mode, embedded-in-text, `t.co` detection) + `canonicalUrl()`; scheme-less and protocol-relative forms; hostile-host rejection via candidate anchoring + boundary rule (audit rev 2).
- [ ] `token.ts` — `syndicationToken(id)`; **golden tests ported from xdl's 17 Node vectors**.
- [ ] `select.ts` — `best` / `worst` / `maxHeight` with above-cap fit.
- [ ] `naming.ts` — sanitizer (reserved names, control chars, trailing ` .`, 120-char, surrogate-safe) + `{id,date,author,index,slug}` templates + layouts.
- [ ] `parseRunInput(text)` — textarea → `{ url, lineNumber, problems[] }[]` (comments/blanks/dupes), pure and shared with the renderer.
- [ ] Vitest tables for all of the above (target: ~120 cases, all hermetic).

**Done when:** `pnpm test -- downloader` is green and DA10 (hostile URLs) passes as a unit test.

## D1 — Resolve chain + CLI dry-run (≈ 2–3 days)

**Goal:** `pnpm cli dl <url> --dry-run` prints exactly what would be downloaded, for any supported link form.

- [ ] `net/client.ts` — allow-list, `getJson`, `expandTco`, timeouts, injectable `fetchImpl`; unit tests with hostile-host matrix.
- [ ] `resolve/syndication.ts` — request shape (`id/lang/token/features`), token use, payload mapping (media kinds, variants, `original_info`/`sizes` fallback, created_at formats), error mapping (404/tombstone/no-mediaDetails → `NOT_EMBEDDABLE`; 401/403 → `AUTH_REQUIRED`; 429 → `RATE_LIMITED` with Retry-After).
- [ ] `resolve/fxtwitter.ts` — opt-in adapter, payload mapping, error mapping.
- [ ] `resolve/chain.ts` — fall-through, terminal folding (`NOT_FOUND` > `RATE_LIMITED` > last), trail in the message.
- [ ] Fixtures: record ≥ 6 real payloads (single video, multi-video, gif, photo-only, tombstone, sensitive-ish 404 shape) + `scripts/record-dl-fixture.ts`.
- [ ] `pnpm cli dl` — `--dry-run`, `--quality`, `--fallback`, exit codes `0/1/2`; table output.
- [ ] Settings-independent defaults resolvable from CLI flags only.

**Done when:** a live `--dry-run` of one real post prints author, caption, dims, chosen variant and planned path; the hermetic suite proves the same mappings from fixtures; DA7 passes (fallback semantics).

## D2 — Engine + storage + orchestrator (≈ 3–4 days)

**Goal:** `pnpm cli dl <url…>` actually downloads a batch, with resume, skip, retry and state — still no GUI.

- [ ] `engine/fetch.ts` — `.part`, Range resume, 206/200 handling, `416` → finalize-or-restart, exact-size verify, fsync, atomic rename, `flags`+`start` resume write, `403 → LINK_EXPIRED`, `ENOSPC → DISK_FULL`, abort keeps `.part` (audit rev 2).
- [ ] `engine/throttle.ts` — slot-reserving gate with wake-and-recheck (no firing inside a 429 cooldown, no false escalation); global 429 pause; 3-in-60 s escalation; injected clock tests (audit rev 2).
- [ ] `store/state.ts` — schema v1, atomic flush via `core/store/fs-utils`, completeness check, skip/retry queries, re-finalize rule, corrupt-file quarantine.
- [ ] `store/sidecar.ts` — payload schema, atomic write, write order honored.
- [ ] `orchestrator.ts` — normalize → dedupe → **pre-skip before any resolve** → bounded lookahead (`K = 2× downloadConcurrency`) → two semaphores → per-item containment → verdicts → summary; `onEvent` seam; cancellation drain (audit rev 2).
- [ ] Retry policy — backoff (1 s → 4 s → 15 s, jittered), retryable set, one `LINK_EXPIRED` re-resolve, one clean `INTEGRITY_MISMATCH` restart.
- [ ] CLI end-to-end: `dl --out`, `--no-meta`, `--force`, `--retry-failed` (reads state), summary table.
- [ ] Integration tests with a fake media server (in-process `hl`/`http` on 127.0.0.1) for Range/429/403-mid-stream cases.

**Done when:** DA1–DA6 pass through the CLI on fixtures + one live smoke; a 10-URL batch survives a killed process and resumes.

## D3 — GUI: the Downloader screen (≈ 3–4 days)

**Goal:** the actual product loop: paste → watch rows → "New project".

- [ ] `src/main/downloader.ts` — `dl:start/analyze/cancel/list`, single-flight slot, settings → options, event coalescing (~10 Hz + immediate transitions).
- [ ] `api.d.ts` + `preload/index.ts` — the five new bridge methods, types re-exported from `shared/downloader`.
- [ ] `DownloaderScreen.tsx` — textarea (line numbers, parse verdicts live, `readOnly` while a run is active), toolbar (Analyze = dry-run, Download, Cancel, Retry failed, Open folder), run list with per-item status/progress/error/actions + `NOT_EMBEDDABLE` fallback hint; empty state with the legal line (audit rev 2).
- [ ] `dlStore.ts` (zustand) — run lifecycle, event application, per-line state machine; `strings.ts` copy.
- [ ] Home entry (`onOpenDownloader`, mirroring `onOpenBatch`); `Screen` union + `App.tsx` route.
- [ ] Per-item actions: New project (reuses `createProject`), Reveal, Copy path, Copy URL.
- [ ] Settings modal: Downloads section (dir picker, quality, concurrency, fallback toggle, sidecars toggle) + `Settings` schema migration in `core/store/settings.ts` (defaults merge, no version bump needed if additive).
- [ ] IPC-level tests for the coalescer; E2E smoke with the fixture client (`SHORTZ_DL_FIXTURE=1`).

**Done when:** DA1–DA3 and DA8 pass through the GUI by hand and in the E2E smoke; a friend can download a post and land in the editor without instructions.

## D4 — Resilience & completeness (≈ 1–2 days)

**Goal:** long batches on bad networks stop being scary.

- [ ] Circuit breaker (8 consecutive failed/partial → open; remaining `skipped (circuit open)`; summary line).
- [ ] `.part` resume across app restarts (state-independent: size + Range probe decides).
- [ ] Retry-failed from the GUI reads state and re-enqueues only failed/incomplete rows.
- [ ] Disk-full + write-error paths surfaced per item, batch continues.
- [ ] Hostile-input hardening pass: percent-encoded hosts, IDN lookalikes, `..` in captions, 300-char URLs, CRLF injection attempts in file names.
- [ ] Live matrix run: 30 real links across single/multi/gif/deleted/sensitive; document results in `docs/` changelog note; assert every observed variant URL host is inside the media allow-list (evidence gate before ever widening it — audit rev 2).

**Done when:** a 30-link real batch finishes unattended with correct skip state on a second run; no item can crash the run.

## D5 — Optional fallbacks & conveniences (≈ 2–3 days, each independently shippable)

- [ ] **yt-dlp sidecar (Adapter D)** — opt-in "Enable fallback resolver" downloads a pinned `yt-dlp.exe` (hash-verified) to `<dataDir>\bin\`; `-J` resolve-only; `stale ≥ 14 days` badge; error-string → `DlErrorCode` mapping table; delete button.
- [ ] **HLS remux** — chosen variant is m3u8 → download segments via ffmpeg (bundled) to MP4; progress from ffmpeg `-progress`.
- [ ] **GIF conversion** — per-item "convert to real GIF" (palettegen/paletteuse, ffmpeg); default stays silent MP4.
- [ ] **Send to Batch** — downloaded row → Batch screen line (`path•hook` prefilled with the caption), closing the download→bulk-render loop with zero retyping.
- [ ] **Quality override per run** in the toolbar (best/720/480).
- [ ] **Parking lot items only if demanded:** proxy support (`net.fetch` switch), watch-folder/scheduled downloads, photo download, per-post thread expansion (quoted/replied video).

**Done when:** with the fallback enabled, a post that syndication refuses resolves through yt-dlp; HLS-only payloads produce a playable MP4.

## Estimate roll-up

| Milestone | Days (evenings) | Cumulative |
|---|---|---|
| D0 | 1–2 | 2 |
| D1 | 2–3 | 5 |
| D2 | 3–4 | 9 |
| D3 | 3–4 | 13 |
| D4 | 1–2 | 15 |
| D5 | 2–3 | 18 |

MVP (D0–D3) ≈ **9–13 evenings**. That is the honest cost of porting a hardened design; it is *not* the cost of "a fetch and a save".

## Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| Syndication endpoint changes shape or starts validating tokens | Resolve breaks | Token is exact by construction (V8 native); `FEATURES` pinned as one constant; fixtures catch shape drift in CI; fxtwitter (opt-in) and yt-dlp (opt-in) exist as second hops; mapping code isolated per adapter |
| Syndication refuses more posts over time (sensitive/login-walled) | More `NOT_EMBEDDABLE` lines | Correct semantics (never "deleted"); fallback chain; UI explains; yt-dlp sidecar (D5) is the pressure valve |
| 429 waves on big batches | Slow/blocked runs | Default concurrency 3, jittered pacing, **global** pause (one 429 pauses everyone), escalation, retries with backoff; batch keeps going per item |
| Signed media URLs expire mid-transfer (403) | Failed items | Bounded lookahead keeps resolve→download latency short; `LINK_EXPIRED` → one orchestrator re-resolve → Range-resume from `.part` (designed in D2, tested; rev 2) |
| Preview/state drift: renderer shows a planned path the core doesn't use | Confusing UX | `naming.ts` is pure and shared — the renderer computes the path with the same function the core uses (same trick as the shared layout engine) |
| A malformed post kills a 500-line batch | Total loss of a run | Item-boundary containment + circuit breaker + per-line verdicts; `UNEXPECTED` is a per-item code, never a crash |
| Windows path edge cases (reserved names, MAX_PATH, unicode) | Broken saves | Ported sanitizer + dedicated test table (D0) + long-path-safe roots |
| Disk fill during overnight batch | Partial files | Per-item `DISK_FULL`, batch continues, `.part` cleanup policy documented |
| Scope creep into "a downloader app" | Never ships the editor loop | Non-goals list is the contract; every request must make *download → edit* faster, or it is parking-lot |
| Legal/ToS surface | — | Local personal-use tool, no redistribution, no DRM circumvention, no accounts; one-line notice in the empty state; nothing uploaded |

## Deliberately not built (and why)

- **Login/cookies** — turns a local tool into a credential holder; `AUTH_REQUIRED` is the product boundary.
- **In-app browser / link sharing** — not needed for the loop; the OS clipboard is enough.
- **Scheduler / watch folder** — a different product (an appliance). Would need a background service, autostart, and silent network — all against the posture.
- **Photo downloading** — ShortZ edits video; photos would be dead weight in the library.
- **A `yt-dlp`-only path with no local resolver** — see `03-tech-stack.md` Option C.
- **Torrent/other platforms** — the URL grammar is closed on purpose; a plugin system is a maintenance tax with no user in this repo.
- **Global download queue across features** — one slot, one job; the app is a single-user desktop tool.
