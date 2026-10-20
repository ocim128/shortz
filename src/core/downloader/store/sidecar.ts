/**
 * `<file>.mp4.meta.json` — the self-describing sidecar (storage-naming.md §3).
 *
 * One per media file, so `_v2.mp4` explains itself outside the app (caption,
 * origin, provenance). Written atomically (temp + rename) and only in the order
 * media rename → sidecar → state row: a state row never points at a file that
 * does not exist.
 */

import { promises as fs } from 'node:fs'
import type {
  MediaAsset,
  MediaKind,
  ResolvedTweet,
  ResolverName,
  Variant
} from '../../../shared/downloader/types'
import { atomicWriteFile } from '../../store/fs-utils'

/** Mirrors package.json; kept as a constant so the pure/core tiers stay build-free. */
export const SHORTZ_VERSION = '0.0.1'

export interface SidecarMediaEntry {
  index: number
  kind: MediaKind
  file: string
  width: number | null
  height: number | null
  bitrate: number | null
  contentType: string | null
  sourceVariantUrl: string
  sizeBytes: number
  posterUrl: string | null
}

export interface SidecarPayload {
  schemaVersion: 1
  tweetId: string
  url: string
  text: string
  createdAt: string | null
  author: { screenName: string; displayName: string | null; verified: boolean }
  media: SidecarMediaEntry[]
  source: ResolverName
  downloadedAt: string
  shortzVersion: string
}

export function sidecarPathFor(mediaPath: string): string {
  return `${mediaPath}.meta.json`
}

/** Build the payload for one downloaded media file. */
export function buildSidecarPayload(args: {
  resolved: ResolvedTweet
  asset: MediaAsset
  variant: Variant
  fileName: string
  sizeBytes: number
  downloadedAt?: string
}): SidecarPayload {
  const { resolved, asset, variant, fileName, sizeBytes } = args
  return {
    schemaVersion: 1,
    tweetId: resolved.ref.tweetId,
    url: resolved.ref.canonicalUrl,
    text: resolved.text,
    createdAt: resolved.createdAt,
    author: {
      screenName: resolved.author.screenName,
      displayName: resolved.author.displayName,
      verified: resolved.author.verified
    },
    media: [
      {
        index: asset.index,
        kind: asset.kind,
        file: fileName,
        width: variant.width ?? asset.width,
        height: variant.height ?? asset.height,
        bitrate: variant.bitrate,
        contentType: variant.contentType,
        sourceVariantUrl: variant.url,
        sizeBytes,
        posterUrl: asset.posterUrl
      }
    ],
    source: resolved.source,
    downloadedAt: args.downloadedAt ?? new Date().toISOString(),
    shortzVersion: SHORTZ_VERSION
  }
}

/** Atomic write; returns the sidecar path. */
export async function writeSidecar(mediaPath: string, payload: SidecarPayload): Promise<string> {
  const sidecar = sidecarPathFor(mediaPath)
  await atomicWriteFile(sidecar, JSON.stringify(payload, null, 2))
  return sidecar
}

/** Read a sidecar back (the re-finalize path); corrupt/missing → null. */
export async function readSidecar(mediaPath: string): Promise<SidecarPayload | null> {
  try {
    const raw = await fs.readFile(sidecarPathFor(mediaPath), 'utf8')
    const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) return null
    return parsed as SidecarPayload
  } catch {
    return null
  }
}

export async function removeSidecar(mediaPath: string): Promise<void> {
  await fs.unlink(sidecarPathFor(mediaPath)).catch(() => undefined)
}
