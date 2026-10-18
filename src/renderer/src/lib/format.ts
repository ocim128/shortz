/** Small formatting helpers shared by the screens. */

/** 65.4 → "1:05"; 7.2 → "0:07" (ui-spec mockups use m:ss). */
export function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00'
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** "2h" / "1d" / "3d" style relative age for project cards. */
export function formatRelativeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return ''
  const min = Math.round(ms / 60_000)
  if (min < 60) return `${Math.max(1, min)}m`
  const h = Math.round(min / 60)
  if (h < 24) return `${h}h`
  return `${Math.round(h / 24)}d`
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${bytes} B`
}

/** Round to even (H.264 yuv420p requirement; matches the shared engine's even rounding). */
export function roundEven(n: number): number {
  return Math.round(n / 2) * 2
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n))
}

/** Snap to 0.1 s (ui-spec: trim snapping). */
export function snapTenths(n: number): number {
  return Math.round(n * 10) / 10
}

/**
 * Canonical frame rates for display: probe values carry float noise (24000/1001
 * = 23.97602…, legacy projects stored 23.98), so snap within tolerance before
 * showing. Unmatched rates display at up to 3 decimals.
 */
const CANONICAL_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60, 90, 100, 120]

/** 23.976023 → "23.976"; 23.98 (legacy persisted) → "23.976"; 24 → "24". */
export function formatFps(fps: number): string {
  if (!Number.isFinite(fps) || fps <= 0) return ''
  let best = fps
  let bestDiff = Infinity
  for (const c of CANONICAL_FPS) {
    const diff = Math.abs(fps - c)
    if (diff < bestDiff) {
      best = c
      bestDiff = diff
    }
  }
  if (bestDiff > 0.05) best = Math.round(fps * 1000) / 1000
  return String(best)
}
