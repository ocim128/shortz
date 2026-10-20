/**
 * The closed X/Twitter status-URL grammar (docs/twitter-downloader/technical/
 * resolver-chain.md §1).
 *
 * Pure string work: no `node:`, no DOM. The renderer previews with exactly these
 * functions and the core parses with the same ones, so a line can never be
 * "valid in the UI, invalid in main".
 *
 * Accepted forms — mirrors count, `www.`/`mobile.` tolerated, scheme and `//`
 * BOTH optional (a bare `x.com/user/status/123` paste is normal):
 *
 *   x.com/<user>/status(es)/<id>          the canonical form
 *   x.com/i/web/status/<id>               what the logged-out web app hands out
 *   x.com/<user>/intent/(post|tweet)?tweet_id=<id>
 *   platform.twitter.com/embed/Tweet.html?id=<id>
 *   x.com / twitter.com / fxtwitter.com / vxtwitter.com / fixupx.com / twittpr.com
 *   t.co/<code>                           detected only — the core expands it (one hop)
 *   a status URL buried in a sentence, quoted, or inside brackets
 *
 * Rejected (DA10): a foreign host, `evil.example/x.com/...`, `max.com/x.com/...`
 * (the host must start the text or follow space/quote/bracket, never a path
 * slash), `x.com.evil.example`, plain TWEET_ID_INVALID ids.
 */

import { DlError } from './errors'
import type { TweetRef } from './types'

const HOSTS = '(?:platform\\.twitter|fxtwitter|vxtwitter|fixupx|twittpr|x|twitter)\\.com'
const HOST_PREFIX = `(?:www\\.|mobile\\.)?${HOSTS}`

/** Scheme and `//` are BOTH optional — `x.com/user/status/123` is a standard paste. */
const SCHEME = '(?:(?:https?:)?//)?'

/**
 * Free-text anchoring (audit rev 2): the host must start the string or follow
 * whitespace, a quote, `(` or `<`. This is what keeps `evil.example/x.com/…` out.
 */
const BOUNDARY = '(?<=^|[\\s"\'<(])'

/**
 * Lenient id capture: extraction must still return the URL of a status-shaped
 * path whose id is implausible, so `parseStatusUrl` can raise TWEET_ID_INVALID
 * instead of the generic URL_UNRECOGNIZED. Validation (2–19 digits) happens in
 * `assertTweetId`.
 */
const ANY_ID = '(?<id>\\d+)(?![\\dA-Za-z_])'

/** Optional trailing path (`/photo/1`), port and query/fragment — tolerated, ignored. */
const TAIL = '(?:/[^\\s?&#]*)?(?:[?&#][^\\s]*)?'
const PORT = '(?::\\d+)?'

const STATUS_BODY = `${PORT}/(?<user>[A-Za-z0-9_]{1,15})/status(?:es)?/${ANY_ID}${TAIL}`
const WEB_BODY = `${PORT}/i/web/status(?:es)?/${ANY_ID}${TAIL}`
/** `x.com/intent/post?tweet_id=…` — an optional handle segment is tolerated (`x.com/<user>/intent/…`). */
const INTENT_PATH = `${PORT}(?:/[A-Za-z0-9_]{1,15})?/intent/(?:post|tweet)`
const EMBED_PATH = '/embed/Tweet\\.html'

/** Whole-token match (normal path, incl. scheme-less and protocol-relative). */
export const STATUS_RE = new RegExp(`${SCHEME}${HOST_PREFIX}${STATUS_BODY}`)

/**
 * Free-text extraction. The host must start the string or follow space, quote,
 * `(` or `<` — so `evil.example/x.com/…` and `max.com/x.com/…` cannot smuggle an
 * embedded status past the parser (audit rev 2; DA10 pins it).
 */
export const STATUS_IN_TEXT_RE = new RegExp(`${BOUNDARY}${SCHEME}${HOST_PREFIX}${STATUS_BODY}`, 'g')

/** `/i/web/status(es)/<id>` — the "logged-out" internal form the web app hands out. */
export const WEB_RE = new RegExp(`${BOUNDARY}${SCHEME}${HOST_PREFIX}${WEB_BODY}`, 'g')

/** `/intent/post|tweet?tweet_id=<id>` (both verb spellings — xdl D4). */
export const INTENT_RE = new RegExp(
  `${BOUNDARY}${SCHEME}${HOST_PREFIX}${INTENT_PATH}(?:[?&#][^\\s]*)?`,
  'g'
)

/** platform.twitter.com/embed/Tweet.html?id=<id> — what "Embed post" copies. */
export const EMBED_RE = new RegExp(
  `${BOUNDARY}${SCHEME}${HOST_PREFIX}${EMBED_PATH}(?:[?&#][^\\s]*)?`,
  'g'
)

/** t.co/<code> — matched to detect "needs expansion", never parsed as an id source. */
export const TCO_RE = new RegExp(
  `${BOUNDARY}(?:(?:https?:)?//)?(?:www\\.)?t\\.co/(?<code>[A-Za-z0-9]+)`,
  'gi'
)

/** Status-shaped path on an ALLOWED host with an implausible id (DA10: foreign hosts stay silent). */
const BAD_ID_RE = new RegExp(
  `${BOUNDARY}${SCHEME}${HOST_PREFIX}${PORT}(?:/(?:[A-Za-z0-9_]{1,15}/)?status(?:es)?|/i/web/status(?:es)?)/(\\d+)`,
  'g'
)

const TWEET_ID_SHAPE = /^\d{2,19}$/

/** Every match of a global regex, with `lastIndex` reset (regexes are module singletons). */
function allMatches(re: RegExp, text: string): RegExpExecArray[] {
  re.lastIndex = 0
  const out: RegExpExecArray[] = []
  for (;;) {
    const match = re.exec(text)
    if (match === null) return out
    out.push(match)
    if (match[0].length === 0) re.lastIndex += 1
  }
}

function firstMatch(re: RegExp, text: string): RegExpExecArray | null {
  return allMatches(re, text)[0] ?? null
}

function assertTweetId(id: string): string {
  if (!TWEET_ID_SHAPE.test(id)) {
    throw new DlError('TWEET_ID_INVALID', `"${id}" is not a valid post id (2–19 digits)`)
  }
  return id
}

/** The display/allow-list URL every adapter and the UI use, whatever was pasted. */
export function canonicalUrl(tweetId: string, screenName: string | null): string {
  const user = screenName !== null && screenName.length > 0 ? screenName : 'i'
  return `https://x.com/${user}/status/${tweetId}`
}

function makeRef(tweetId: string, screenName: string | null): TweetRef {
  return { tweetId, screenName, canonicalUrl: canonicalUrl(tweetId, screenName) }
}

function paramValue(url: string, name: string): string | null {
  const re = new RegExp(`[?&#]${name}=(\\d+)`)
  const match = re.exec(url)
  return match === null ? null : (match[1] as string)
}

/** Build a ref from one extracted URL substring; throws when the id is implausible. */
function refFromUrl(url: string): TweetRef {
  const web = firstMatch(WEB_RE, url)
  if (web !== null) {
    const id = assertTweetId((web.groups?.id as string | undefined) ?? '')
    return makeRef(id, null)
  }
  const status = firstMatch(STATUS_IN_TEXT_RE, url)
  if (status !== null) {
    const id = assertTweetId((status.groups?.id as string | undefined) ?? '')
    const user = status.groups?.user as string | undefined
    return makeRef(id, user ?? null)
  }
  const intent = firstMatch(INTENT_RE, url)
  if (intent !== null) {
    const raw = paramValue(intent[0], 'tweet_id')
    if (raw !== null) return makeRef(assertTweetId(raw), null)
  }
  const embed = firstMatch(EMBED_RE, url)
  if (embed !== null) {
    const raw = paramValue(embed[0], 'id')
    if (raw !== null) return makeRef(assertTweetId(raw), null)
  }
  throw new DlError('URL_UNRECOGNIZED', `not a status link: ${url}`)
}

/** True when the text is (or starts) a t.co short link — the core expands it, once. */
export function isTcoUrl(text: string): boolean {
  return firstMatch(TCO_RE, text) !== null
}

/**
 * The URL substring a line contains, or null. Includes t.co links (their
 * expansion is the core's single network hop) and status-shaped URLs whose id is
 * implausible (so the caller can report TWEET_ID_INVALID rather than "no link").
 */
export function extractStatusUrl(line: string): string | null {
  const matches = extractAllStatusUrls(line)
  return matches[0] ?? null
}

/** Every distinct URL substring in the line — `multiple-links` detection. */
export function extractAllStatusUrls(line: string): string[] {
  const found: string[] = []
  const push = (value: string): void => {
    if (!found.includes(value)) found.push(value)
  }
  const forms: RegExp[] = [STATUS_IN_TEXT_RE, WEB_RE, INTENT_RE, EMBED_RE, TCO_RE]
  for (const re of forms) {
    for (const match of allMatches(re, line)) {
      push(match[0])
      // A recovered intra-word match (a status URL inside `…?url=https://x.com/…`)
      // would be missed by the anchored scan; the `?url=` case is handled by the
      // intent form itself, so nothing else is needed here.
    }
  }
  return found
}

/**
 * Parse one pasted line into a {@link TweetRef}.
 *
 * @param opts.allowBareId CLI `--id` mode only. The GUI textarea never accepts a
 * bare id: a 19-digit number inside a pasted paragraph must not become a download.
 * @throws DlError URL_UNRECOGNIZED | TWEET_ID_INVALID
 */
export function parseStatusUrl(text: string, opts: { allowBareId?: boolean } = {}): TweetRef {
  const trimmed = text.trim()
  if (trimmed.length === 0) throw new DlError('URL_UNRECOGNIZED', 'empty input')

  if (opts.allowBareId === true && TWEET_ID_SHAPE.test(trimmed)) {
    return makeRef(trimmed, null)
  }

  const extracted = extractStatusUrl(trimmed)
  if (extracted !== null) {
    const statusForm =
      firstMatch(STATUS_IN_TEXT_RE, extracted) ??
      firstMatch(WEB_RE, extracted) ??
      firstMatch(INTENT_RE, extracted) ??
      firstMatch(EMBED_RE, extracted)
    // A pure t.co link has no id yet: the pure parser refuses it here and the
    // core expands it (one hop) before re-parsing (resolver-chain.md §1 rule 3).
    if (statusForm === null) {
      throw new DlError('URL_UNRECOGNIZED', 't.co short link needs expansion')
    }
    return refFromUrl(extracted)
  }

  // Status-shaped but with an implausible id, on an allowed host.
  const bad = firstMatch(BAD_ID_RE, trimmed)
  if (bad !== null && !TWEET_ID_SHAPE.test(bad[1] ?? '')) {
    throw new DlError('TWEET_ID_INVALID', `"${bad[1] ?? ''}" is not a valid post id (2–19 digits)`)
  }

  throw new DlError('URL_UNRECOGNIZED', 'not an X status link')
}

/**
 * The media trust boundary (D-A9 / AUDIT A11): HTTPS only, and the host must be
 * `twimg.com` or `*.twimg.com` — dot-anchored, so `evil-twimg.com`,
 * `twimg.com.evil.example` and `api.x.com` all fail. Re-checked in
 * `engine/fetch.ts` as belt and braces: a hostile URL never reaches a socket.
 */
export function isAllowedMediaUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'https:') return false
  const host = parsed.hostname.toLowerCase()
  return host === 'twimg.com' || host.endsWith('.twimg.com')
}
