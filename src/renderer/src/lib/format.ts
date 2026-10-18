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
