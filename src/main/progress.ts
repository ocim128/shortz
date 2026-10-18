import type { OrchestratorProgress } from '../core/render/orchestrator'
import type { RenderProgressEvent } from '../preload/api'

/**
 * Pure mapping from orchestrator progress to the renderer event — extracted
 * from ipc.ts so the ETA math (which needs the TRIMMED duration) is unit-
 * testable without Electron. Callers pass the post-trim output duration.
 */

function parseSpeed(raw: string | null | undefined): number {
  if (!raw) return 0
  const m = raw.match(/([\d.]+)x?/)
  if (!m) return 0
  const v = Number(m[1])
  return Number.isFinite(v) ? v : 0
}

export function toProgressEvent(
  p: OrchestratorProgress,
  durationSec: number
): RenderProgressEvent {
  const speed = parseSpeed(p.speed)
  const pct = p.pct < 0 ? 0 : p.pct > 100 ? 100 : Math.round(p.pct)
  const done = p.stage === 'done'
  let etaSec: number | null = null
  if (!done && speed > 0 && p.outTimeSec !== undefined && durationSec > p.outTimeSec) {
    etaSec = (durationSec - p.outTimeSec) / speed
  }
  return {
    jobId: p.jobId,
    percent: pct,
    outTimeSec: p.outTimeSec ?? 0,
    speed,
    etaSec,
    done,
    stage: p.stage
  }
}
