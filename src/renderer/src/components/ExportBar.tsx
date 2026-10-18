import { useRenderStore } from '../stores/renderStore'
import { S } from '../strings'

/**
 * ExportBar — bottom render bar (ui-spec §editor): live stage/progress/eta
 * while an export runs, error strip with stderr details on failure. Silent
 * (renders nothing) when idle — the top-bar Export button starts jobs.
 */

const STAGE_LABELS: Record<string, string> = {
  probe: 'probing',
  resolve: 'layout',
  overlay: 'overlay',
  render: '',
  finalize: 'moving',
  done: ''
}

function stageLabel(stage: string | undefined): string {
  if (!stage) return ''
  const base = STAGE_LABELS[stage] ?? stage
  return base.length > 0 ? ` — ${base}` : '…'
}

export function ExportBar(): JSX.Element | null {
  const status = useRenderStore((s) => s.status)
  const progress = useRenderStore((s) => s.progress)
  const error = useRenderStore((s) => s.error)
  const cancel = useRenderStore((s) => s.cancel)
  const dismiss = useRenderStore((s) => s.dismiss)

  if (status === 'error') {
    return (
      <footer className="export-bar export-bar--error" role="alert">
        <span className="export-bar__label">{S.exportErrorTitle}</span>
        {error && (
          <details className="export-bar__stderr">
            <summary>stderr tail</summary>
            <pre>{error}</pre>
          </details>
        )}
        <button type="button" className="btn btn-sm export-bar__cancel" onClick={dismiss}>
          {S.exportErrorDismiss}
        </button>
      </footer>
    )
  }

  if (status === 'running') {
    const pct = Math.round(progress?.percent ?? 0)
    return (
      <footer className="export-bar export-bar--busy" aria-live="polite">
        <span className="export-bar__label">
          {S.rendering}
          {progress?.stage ? stageLabel(progress.stage) : ''}
        </span>
        <div className="export-bar__progress">
          <div className="export-bar__progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="export-bar__pct">{pct}%</span>
        {progress?.etaSec != null && progress.etaSec > 0 && (
          <span className="export-bar__eta">{S.eta(Math.ceil(progress.etaSec))}</span>
        )}
        <button
          type="button"
          className="btn btn-sm export-bar__cancel"
          onClick={() => void cancel()}
          title={S.cancelExportHint}
        >
          {S.cancelExport}
        </button>
      </footer>
    )
  }

  return null
}
