/**
 * Minimal process-wide logger. Console output always; an optional file sink
 * (installed by the Electron main process) mirrors lines into an append-only,
 * size-capped main.log, so packaged builds — which have no attached console —
 * still produce a supportable artifact. Core stays platform-free: the shell
 * decides where lines land, and logging must never throw.
 */
type FileSink = (line: string) => void

let sink: FileSink | null = null

export function setLogSink(next: FileSink): void {
  sink = next
}

export function logInfo(message: string): void {
  console.log(message)
  try {
    sink?.(`${new Date().toISOString()} [info] ${message}`)
  } catch {
    /* never propagate logging failures */
  }
}

export function logWarn(message: string): void {
  console.warn(message)
  try {
    sink?.(`${new Date().toISOString()} [warn] ${message}`)
  } catch {
    /* never propagate logging failures */
  }
}

/** Persist a fatal (kind + error detail); returns the formatted line. */
export function logError(kind: string, error: unknown): string {
  const detail =
    error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error)
  const line = `${new Date().toISOString()} [error] ${kind}: ${detail}`
  try {
    sink?.(line)
  } catch {
    /* never propagate logging failures */
  }
  return line
}
