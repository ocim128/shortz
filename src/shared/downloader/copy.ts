/**
 * The only place downloader sentences exist (AUDIT A7).
 *
 * Pure: no `node:`, no DOM. The core emits codes; the main process, the CLI and
 * the renderer all phrase them through here, so a log line and a row can never
 * disagree about what happened.
 */

import type { DlErrorCode, DlSkipReason } from './types'

const MESSAGES: Record<DlErrorCode, string> = {
  URL_UNRECOGNIZED: "That doesn't look like an X post link.",
  TWEET_ID_INVALID: "That post id doesn't look right — check the link.",
  // AUDIT A1 / rev 3: the honest three-cause sentence. The syndication endpoint
  // cannot distinguish deleted from private from sensitive, so the copy must not
  // pick one — only the primary adapter or the failure-path probe may say
  // "deleted", and those report NOT_FOUND instead.
  NOT_EMBEDDABLE: "Can't embed this post — it may be deleted, private, or sensitive.",
  NOT_FOUND: 'Post not found — it was deleted or never existed.',
  AUTH_REQUIRED: "This post needs a logged-in session — ShortZ doesn't sign in to X.",
  NO_VIDEO: 'No video in this post.',
  RATE_LIMITED: 'X is rate-limiting downloads — try again in a few minutes.',
  LINK_EXPIRED: 'The download link expired — retrying with a fresh one.',
  UPSTREAM_ERROR: 'X returned an unexpected response — try again later.',
  NETWORK: "Couldn't reach X — check your connection and try again.",
  INTEGRITY_MISMATCH: "The download didn't match the expected size — restarting it.",
  DISK_FULL: 'Not enough free disk space for this download.',
  WRITE_ERROR: "Couldn't write the file to that folder.",
  CANCELLED: 'Cancelled.',
  UNEXPECTED: 'Something unexpected went wrong with this line.'
}

export function dlErrorMessage(code: DlErrorCode): string {
  return MESSAGES[code]
}

const SKIP_TEXT: Record<DlSkipReason, string> = {
  'already-downloaded': 'Already downloaded.',
  duplicate: 'Duplicate link in this batch.',
  'circuit-open': 'Skipped — the run stopped after repeated failures.'
}

export function dlSkipText(reason: DlSkipReason): string {
  return SKIP_TEXT[reason]
}
