import { useRenderStore } from '../stores/renderStore'
import { S } from '../strings'

/**
 * ExportBar — bottom render bar (ui-spec §editor): only meaningful while a
 * job runs. Until the engine lands, the strip stays in a visibly-disabled
 * "engine pending" state; Export lives in the top bar (disabled + tooltip).
 */
export function ExportBar(): JSX.Element {
  const status = useRenderStore((s) => s.status)
  const progress = useRenderStore((s) => s.progress)
  const error = useRenderStore((s) => s.error)

  if (status === 'idle' && !error) {
    return (
      <footer className="export-bar export-bar--pending" aria-live="polite">
        <span className="export-bar__pending-note">⚙ {S.enginePendingBar}</span>
      </footer>
    )
  }

  if (status === 'error') {
    return (
      <footer className="export-bar export-bar--error" role="alert">
        <span className="export-bar__label">Render failed</span>
        {error && (
          <details className="export-bar__stderr">
            <summary>stderr tail</summary>
            <pre>{error}</pre>
          </details>
        )}
      </footer>
    )
  }

  const pct = Math.round(progress?.percent ?? 0)
  return (
    <footer className="export-bar export-bar--busy" aria-live="polite">
      <span className="export-bar__label">Rendering…</span>
      <div className="export-bar__progress">
        <div className="export-bar__progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="export-bar__pct">{pct}%</span>
      {progress?.etaSec != null && <span className="export-bar__eta">eta {Math.ceil(progress.etaSec)}s</span>}
    </footer>
  )
}
