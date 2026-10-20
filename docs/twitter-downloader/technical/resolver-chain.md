# Technical — Resolver Chain (URLs → chosen media variants)

The part most likely to break in production, therefore the part with the most tests. All code lives in `src/shared/downloader/{urls,token,select,types,errors}.ts` (pure) and `src/core/downloader/resolve/{syndication,fxtwitter,ytdlp,chain}.ts` (I/O). Everything here is a port of xdl (`src/xdl/urls.py`, `resolve/*`) with xdl's `DECISIONS.md` cited as D#.

## 1. URL grammar — the closed set of accepted inputs

Host list (exact registrable-domain match, mirrors count):

```
platform.twitter.com · fxtwitter.com · vxtwitter.com · fixupx.com · twittpr.com · x.com · twitter.com
```
with optional `www.` / `mobile.` prefixes. Scheme-less (`x.com/…`) and protocol-relative (`//x.com/…`) forms are tolerated; `t.co` short links require one expansion hop (network → core's `expandTco`, then re-parse).

```ts
// src/shared/downloader/urls.ts (shape — exact regexes)
const HOSTS = '(?:platform\\.twitter|fxtwitter|vxtwitter|fixupx|twittpr|x|twitter)\\.com'
const HOST_PREFIX = `(?:www\\.|mobile\\.)?${HOSTS}`

/** Scheme and // are BOTH optional — `x.com/user/status/123` is a standard paste. */
const SCHEME = '(?:(?:https?:)?//)?'

/** `/<user>/status(es)/<id>` — stray port tolerated, id bounded 2–19 digits. */
const STATUS_BODY =
  '(?::\\d+)?' +
  '/(?<user>[A-Za-z0-9_]{1,15})' +
  '/status(?:es)?/(?<id>\\d{2,19})(?!\\d)' +
  '(?:/[^\\s?&#]*)?' +
  '(?:[?&#][^\\s]*)?'

/** Whole-token match (normal path, incl. scheme-less and protocol-relative). */
export const STATUS_RE = new RegExp(`${SCHEME}${HOST_PREFIX}${STATUS_BODY}`)

/**
 * Free-text extraction. The host must start the string or follow space, quote,
 * '(' or '<' — so `evil.example/x.com/…` and `max.com/x.com/…` cannot smuggle
 * an embedded status past the parser (audit rev 2; DA10 pins it).
 */
export const STATUS_IN_TEXT_RE = new RegExp(
  `(?<=^|[\\s"'<(])${SCHEME}${HOST_PREFIX}${STATUS_BODY}`,
  'g'
)

/** /i/web/status(es)/<id> — the "logged-out" internal form the web app hands out. */
export const WEB_RE = new RegExp(
  `${SCHEME}${HOST_PREFIX}(?::\\d+)?/i/web/status(?:es)?/(?<id>\\d{2,19})(?!\\d)` +
  '(?:/[^\\s?&#]*)?(?:[?&#][^\\s]*)?'
)

/** /intent/post|tweet?tweet_id=<id> (both verb spellings — xdl D4). */
export const INTENT_RE = new RegExp(
  `${SCHEME}${HOST_PREFIX}(?::\\d+)?/intent/(?:post|tweet)(?:[?&#][^\\s]*)?`
)

/** platform.twitter.com/embed/Tweet.html?id=<id> — what "Embed post" copies. */
export const EMBED_RE = new RegExp(
  `${SCHEME}platform\\.twitter\\.com/embed/Tweet\\.html(?:[?&#][^\\s]*)?`
)

/** t.co/<code> — matched to detect "needs expansion", never parsed as an id source. */
export const TCO_RE = new RegExp('(?:https?:)?//(?:www\\.)?t\\.co/(?<path>[A-Za-z0-9]+)', 'i')
```

Parse order and rules (port of `urls.py::parse`):

1. Empty → `URL_UNRECOGNIZED`.
2. Bare numeric id only in explicit `--id` mode (CLI); the GUI textarea never accepts bare ids (ambiguous with junk lines) — **deviation from xdl, deliberate**: GUI input is free text; a bare 19-digit number in a pasted paragraph must not become a download.
3. `t.co` full-match → typed error "short link needs expansion" in the *pure* parser; the core's `normalize()` expands it first (one redirect hop, `Location` header, result **re-parsed** — defense in depth).
4. `STATUS_RE` **full-match** on each whitespace-delimited token (scheme-less and protocol-relative included), then `STATUS_IN_TEXT_RE` for a URL buried in a sentence (the host must follow whitespace/quote/bracket — never a path slash), else `WEB_RE`, else intent (`tweet_id` param), else embed (`id` param).
5. A status-shaped path with a wrong-length id on an **allowed** host → `TWEET_ID_INVALID` (not the generic code); on a foreign host → stays `URL_UNRECOGNIZED` (an evil host must not learn our error taxonomy).
6. Output: `TweetRef { tweetId, screenName | null, canonicalUrl: 'https://x.com/<user|i>/status/<id>' }` — the canonical URL is what all adapters and the UI display, whatever the input form was.

**Trust boundary for media** (same rule as xdl): a variant URL is downloadable only if its hostname is `twimg.com`, `*.twimg.com`, `x.com`, or `*.x.com` — dot-anchored suffix match, so `evil-twimg.com` and `twimg.com.evil.example` both fail. Enforced in the client wrapper *and* re-checked in `engine/fetch.ts` (belt and braces).

**Audit note — `*.twitter.com` media (rev 2):** a suggestion to add `twitter.com` to the media allow-list was checked against evidence: X's video/image payloads live on `video.twimg.com`, `pbs.twimg.com`, `ton.twimg.com` — all already inside `*.twimg.com`; no source shows media served from `video.twitter.com`. The boundary therefore stays minimal, and the D4 live matrix asserts every observed variant host is inside it — any future host gets added deliberately, with a fixture, never preemptively.

## 2. The syndication token — one line, exact by construction

react-tweet (Vercel) ships this to production on millions of pages:

```ts
// src/shared/downloader/token.ts — the whole file
/**
 * react-tweet's getToken, byte-exact because BOTH sides run V8's
 * DoubleToRadixStringView: ((Number(id) / 1e15) * Math.PI).toString(36),
 * then strip zero-runs and the radix point. Do not "improve" the precision:
 * Number(id) is lossy above 2^53 by design — the endpoint expects exactly this.
 */
export function syndicationToken(tweetId: string): string {
  return ((Number(tweetId) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '')
}
```

- xdl had to emulate V8's base-36 float formatting in Python (a 150-line Dragon-fraction loop with round-to-even and carry back-trace) and verify 3 000 ids against Node 22. **Electron's main process *is* V8** — the port cannot drift, and the goldens prove it.
- Golden vectors (from xdl's `test_token.py`, 17 total — all become Vitest cases): id `"20"` → `"6dq1a2xwd9"`, plus the 16 others copied verbatim.
- Today the live endpoint does not validate tokens (xdl verified: any non-empty token is accepted), but exactness is free insurance against enforcement being switched on (xdl D1).

## 3. Adapter A — `cdn.syndication.twimg.com` (primary, always on)

**Request** — `GET https://cdn.syndication.twimg.com/tweet-result` with four query parameters: `id` (the tweet id), `lang=en`, the **computed token** from §2, and `features` (the pinned constant below):

`FEATURES` is pinned as one constant (captured from react-tweet's `fetch-tweet.ts`, live-verified 2026-10-17 in xdl; drifts upstream → stored, never modeled):

```
tfw_timeline_list:;tfw_follower_count_sunset:true;tfw_tweet_edit_backend:on;tfw_refsrc_session:on;tfw_show_blue_verified_badge:on;tfw_legacy_timeline_sunset:true;tfw_show_gov_verified_badge:on;tfw_show_business_affiliate_badge:on;tfw_tweet_edit_frontend:on
```

**Response mapping** (`_map_payload` port). Success payload fields used:

| Payload | Into model | Notes |
|---|---|---|
| `text` | `ResolvedTweet.text` | caption; also feeds `{slug}` in naming |
| `created_at` | `createdAt` | ISO 8601 or Twitter's `Wed Oct 22 15:33:18 +0000 2020` — parse both, else `UPSTREAM_ERROR` |
| `user.screen_name` / `name` / `verified` | `Author` | `screen_name` drives the folder name |
| `mediaDetails[]` | `MediaAsset[]` | 1-based `index` in post order |
| `mediaDetails[i].type` | `kind` | `photo` / `video` / `animated_gif → 'gif'` |
| `mediaDetails[i].video_info.variants[]` | `Variant[]` | `{ url, bitrate, content_type }`; dims from `original_info.{width,height}`, else `sizes.large.{w,h}` |
| `mediaDetails[i].media_url_https` | `urlBest` / `posterUrl` | poster image (cached locally for the UI) |

**Status/error mapping — the semantics that matter:**

| HTTP | Code | Fall through? |
|---|---|---|
| 200 + empty object / `TweetTombstone` | `NOT_EMBEDDABLE` | yes |
| 200 but **no `mediaDetails`** | `NOT_EMBEDDABLE` | yes — syndication strips media on sensitive posts too; "no media" is only trustworthy from the *final* adapter (xdl round-2 rule) |
| 404 | `NOT_EMBEDDABLE` | yes — deleted **or** sensitive/age-gated/fresh; not trustworthy as "gone" |
| 401 / 403 | `AUTH_REQUIRED` | yes |
| 429 | `RATE_LIMITED` (+ `Retry-After` parsed: seconds or HTTP-date) | yes (chain folds it) |
| other | `UPSTREAM_ERROR` | yes |
| transport error | `NETWORK` (timeouts separate) | yes |

## 4. Adapter B — `api.fxtwitter.com` (opt-in)

```
GET https://api.fxtwitter.com/status/<tweetId>          Accept: application/json
```

- Off by default. The Settings toggle copy states the cost plainly: *"When ShortZ can't resolve a post itself, it will send the link to fxtwitter.com (a third-party service) to fetch it."*
- Mapping: `tweet.media.videos[] → Variant{ url, width, height }` (single progressive MP4, `bitrate: null`), `tweet.media.photos[] → photo assets` (still reported; only video/gif are downloaded), `created_at` or `created_timestamp` (unix s).
- Errors: 404 → **`NOT_FOUND` (definitive — fxtwitter knows the post table)**; 429 → `RATE_LIMITED`; ≥500 / other → `UPSTREAM_ERROR`; missing `tweet` object → `NOT_FOUND`.

## 5. Adapter D — `yt-dlp` sidecar (D5, opt-in, resolve-only)

```
<bin> yt-dlp -J --no-warnings --skip-download --socket-timeout 15 <canonicalUrl>
```

- Spawned per resolve (not per batch), stdout parsed as **JSON** (`-J`); playlist shape → first `entry`. Never CLI-text scraping; a changed banner cannot break the mapping.
- `formats[]` mapping: skip `vcodec == 'none'` (audio/storyboards); `protocol` starting `m3u8` → `content_type: 'application/x-mpegURL'`; `tbr` (kbps) → `bitrate` (bps); `kind = 'gif'` when **no** format carried audio (X serves GIFs as silent MP4s — that is how muteness is detected, not the label).
- No timestamp/upload_date in the info dict → `UPSTREAM_ERROR` (rare; xdl observed it only on broken extractors).
- Error mapping (string match on the message, lowercase, ported from xdl): `404/not found/deleted/unavailable` → `NOT_FOUND`; `no video` → `NO_VIDEO`; `login/sign in/authenticate/401` → `AUTH_REQUIRED`; `sensitive/age/protected/private` → `NOT_EMBEDDABLE`; `timeout/connection/network/getaddrinfo` → `NETWORK`; else `UPSTREAM_ERROR`.
- Binary management: pinned release URL + SHA-256, downloaded to `<dataDir>\bin\yt-dlp.exe` on explicit user action; staleness badge when the version date is > 14 days old (extractor fixes land continuously — port of `stale_ytdlp_warning`). Runs sync in a worker thread if it ever blocks long (`child_process.execFile` + `util.promisify` — one short call).

## 6. Chain semantics — how failures fold

```ts
// src/core/downloader/resolve/chain.ts (shape)
export class FallbackChain implements Resolver {
  constructor(private readonly adapters: readonly Resolver[]) {}
  async resolve(ref: TweetRef, ctx: ResolveCtx): Promise<ResolvedTweet> {
    const errors: DlError[] = []
    for (const adapter of this.adapters) {
      try { return await adapter.resolve(ref, ctx) } catch (e) { errors.push(asDlError(e)) }
    }
    throw terminalError(errors, this.names)   // every failure falls through — never short-circuit
  }
}
```

- **Every adapter error falls through.** `NOT_EMBEDDABLE` ≠ "post gone"; only `NOT_FOUND` is definitive.
- Terminal error priority (port of `_terminal_error`): `NOT_FOUND` wins → else `RATE_LIMITED` (it is the retryable signal) → else the **last** adapter's error. The message carries the trail: `Not embeddable (sensitive or protected) — tried: syndication → fxtwitter`.
- Composition by settings (port of `build_chain`): `off → [syndication]`; `fxtwitter → [syndication, fxtwitter]`; `auto` (D5) → `[syndication, ytdlp?]` — ytdlp silently skipped when the binary is absent; explicit `ytdlp` fails fast with an install message.

## 7. Error taxonomy (shared with engine/orchestrator/UI)

Port of xdl's `ErrorCode` — one union, one retryability map, user copy in `strings.ts`:

| Code | Meaning | Retryable |
|---|---|---|
| `URL_UNRECOGNIZED` | not an X status link (parse) | no |
| `TWEET_ID_INVALID` | status-shaped, implausible id (2–19 digits) | no |
| `NOT_EMBEDDABLE` | this endpoint refuses (tombstone/sensitive/fresh) | no (chain decides) |
| `NOT_FOUND` | deleted / never existed — **definitive** | no |
| `AUTH_REQUIRED` | login-walled / 401/403 | no |
| `NO_VIDEO` | post has no downloadable video/gif | no |
| `RATE_LIMITED` | 429 anywhere in the chain | **yes** |
| `LINK_EXPIRED` | signed media URL 403 mid-flight | **once** — orchestrator re-resolves |
| `UPSTREAM_ERROR` | 5xx / invalid JSON / unknown upstream shape | **yes** |
| `NETWORK` | transport: timeout, connect fail, reset | **yes** |
| `INTEGRITY_MISMATCH` | size ≠ Content-Length | **one clean restart** |
| `HLS_REQUIRES_FFMPEG` / `HLS_FAILED` | (D5) m3u8 path | no / yes |
| `DRM_UNSUPPORTED` | protected media | no |
| `DISK_FULL` | `ENOSPC` while writing | no (per item) |
| `WRITE_ERROR` | other FS write failure | no |
| `CANCELLED` | user abort | no |
| `FFMPEG_REQUIRED` / `TRANSCODE_FAILED` | (D5 conversions) | no / yes |
| `UNEXPECTED` | a non-`DlError` escaped one item — bug, not weather | no (never retried) |

Retry policy (orchestrator-level, port of xdl): backoff 1 s → 4 s → 15 s with ±20% jitter; `LINK_EXPIRED` retries exactly once *via re-resolve* (fresh signed URL), `INTEGRITY_MISMATCH` exactly once as a clean restart (`.part` deleted).

## 8. Layering rules (the two that keep tests hermetic)

1. **The engine never imports resolver types.** `engine/fetch.ts` takes `(url, dest, ctx)`; the orchestrator hands it the chosen variant URL. A media-layer 403 raises `LINK_EXPIRED` and the *orchestrator* recovers (xdl layering rule 6).
2. **Pure functions never await.** `urls.ts`, `token.ts`, `select.ts`, `naming.ts`, `parseRunInput` are synchronous and dependency-free; only `normalize()` (t.co) and everything under `src/core` await.
