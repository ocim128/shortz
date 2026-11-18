import { createHash } from 'node:crypto'

/**
 * Sec-MS-GEC v2 (CS64-SHA256) token for the Edge TTS endpoint — the handshake
 * Microsoft requires since 2024 (v1 plain hash) / 2025 (v2 with the CS64
 * checksum). Ported from the msedge-tts reference implementation (v2.1.x,
 * itself derived from rany2/edge-tts#492). Pure functions so the bucket math
 * and checksum are unit-testable against fixed timestamps.
 *
 * Token recipe:
 *  1. now → Windows epoch seconds, floored to a 5-minute (300 s) bucket;
 *  2. express as Windows file time (100-ns units) — decimal string;
 *  3. message = EDGE_COPYRIGHT + <filetime><TRUSTED_CLIENT_TOKEN>;
 *  4. digest = SHA-256(message); checksum = CS64(message, digest);
 *  5. token = <checksum hex16>-<digest hex64>, uppercase.
 */

/** Public "trusted client token" every Edge Read Aloud client ships. */
export const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4'

/** Seconds between the Windows epoch (1601) and the Unix epoch (1970). */
const WINDOWS_EPOCH_OFFSET_SEC = 11644473600

const EDGE_COPYRIGHT = 'Copyright (C) Microsoft Corporation. All rights reserved.'

const SWAP_FIRST_WORD = { swappedWord: 0xef0569fb, swappedSum: 0x76f50f34, swappedProduct: 0xc3efea97 } as const
const SWAP_SECOND_WORD = { swappedWord: 0xc31713db, swappedSum: 0x1881ce3c, swappedProduct: 0x35bd1ec9 } as const
const MIX_FIRST_WORD = [0xcf98b111, 0x87085b9f, 0x12ceb96d, 0x257e1d83] as const
const MIX_SECOND_WORD = [0xa27416f5, 0xd38396ff, 0x7c932b89, 0xbfa49f69] as const

/** Current 5-minute bucket as a Windows file time (decimal string). */
export function gecTicks(now: Date = new Date()): string {
  const unixSec = Math.floor(now.getTime() / 1000) + WINDOWS_EPOCH_OFFSET_SEC
  const rounded = unixSec - (unixSec % 300)
  return String(rounded * 10_000_000)
}

function swapHalves(value: number): number {
  return ((value << 16) | (value >>> 16)) >>> 0
}

interface SwapConstants {
  swappedWord: number
  swappedSum: number
  swappedProduct: number
}

function swapTerm(word: number, key: number, m: SwapConstants): number {
  const sum = Math.imul(word, key) + Math.imul(swapHalves(word), m.swappedWord)
  const product = Math.imul(swapHalves(sum), m.swappedSum) >>> 0
  return (Math.imul(swapHalves(product), m.swappedProduct) + product) >>> 0
}

function swapAndMultiply(value: number, multipliers: readonly number[]): number {
  let out = value
  for (const multiplier of multipliers) {
    out = Math.imul(swapHalves(out), multiplier) >>> 0
  }
  return out
}

/** CS64 checksum (8 bytes) over the message, keyed by its own SHA-256 digest. */
function cs64(message: Uint8Array, digest: Uint8Array): Uint8Array {
  const digestView = new DataView(digest.buffer, digest.byteOffset, digest.byteLength)
  const firstKey = (digestView.getUint32(0, true) | 1) >>> 0
  const secondKey = (digestView.getUint32(4, true) | 1) >>> 0

  // The message is read as little-endian 32-bit word pairs, zero-padded to a
  // whole pair.
  const padded = new Uint8Array(Math.ceil(message.length / 8) * 8)
  padded.set(message)
  const words = new DataView(padded.buffer)

  let swapSum = 0
  let lastSwap = 0
  let mix = 0
  let mixSum = 0
  for (let offset = 0; offset < padded.length; offset += 8) {
    const firstWord = words.getUint32(offset, true)
    const secondWord = words.getUint32(offset + 4, true)
    const firstSwap = swapTerm(firstWord, firstKey, SWAP_FIRST_WORD)
    lastSwap = swapTerm(secondWord, secondKey, SWAP_SECOND_WORD)
    swapSum = (swapSum + firstSwap + lastSwap) >>> 0
    mix = swapAndMultiply(Math.imul(mix + firstWord, firstKey), MIX_FIRST_WORD)
    mixSum = (mixSum + mix) >>> 0
    mix = swapAndMultiply(Math.imul(mix + secondWord, secondKey), MIX_SECOND_WORD)
    mixSum = (mixSum + mix) >>> 0
  }

  const checksum = new Uint8Array(8)
  const checksumView = new DataView(checksum.buffer)
  checksumView.setUint32(0, lastSwap ^ mix, true)
  checksumView.setUint32(4, swapSum ^ mixSum, true)
  return checksum
}

function toUpperHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()
}

/** Sec-MS-GEC v2 value for the bucket containing `now`: <CS64>-<SHA256>. */
export function secMsGec(now: Date = new Date()): string {
  const ticksAndToken = `${gecTicks(now)}${TRUSTED_CLIENT_TOKEN}`
  const message = Buffer.from(EDGE_COPYRIGHT + ticksAndToken, 'utf8')
  const digest = new Uint8Array(createHash('sha256').update(message).digest())
  const checksum = cs64(message, digest)
  return `${toUpperHex(checksum)}-${toUpperHex(digest)}`
}
