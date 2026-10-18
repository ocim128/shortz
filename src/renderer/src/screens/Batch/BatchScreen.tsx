import { useCallback, useEffect, useMemo, useState } from 'react'
import type { BatchRenderItem, EditorConfigMeta, Settings } from '../../../../preload/api'
import {
  BATCH_SEPARATOR,
  basenameOf,
  parseBatchText,
  stemOf,
  type BatchLine
} from '../../../../shared/batch/parse'
import { VIDEO_EXTENSIONS } from '../../../../shared/video-extensions'
import { useBatchStore } from '../../stores/batchStore'
import { Icon } from '../../components/Icon'
import { toast } from '../../stores/toastStore'
import { S } from '../../strings'

/**
 * BatchScreen — screen 4: a textarea of `path•hook` lines rendered as one
 * queue. Everything the run needs beyond path + hook (template, knobs, trim,
 * audio) comes from a saved editor config, so this screen never duplicates the
 * editor's field controls.
 *
 * Parsing is delegated to src/shared/batch/parse.ts — the same module main uses
 * — so the per-line verdicts shown here are exactly what will be rendered.
 */

interface BatchScreenProps {
  onBack: () => void
}

interface Problem {
  line: BatchLine
  message: string
}

function lineProblemMessage(line: BatchLine): string | null {
  const problem = line.problems[0]
  if (!problem) return null
  if (problem.code === 'missing-path') return S.batchProblemMissingPath
  if (problem.code === 'unsupported-extension') return S.batchProblemExtension(problem.detail ?? '')
  return S.batchProblemDuplicate(problem.detail ?? '')
}

function statusLabel(status: string): string {
  switch (status) {
    case 'pending':
      return S.batchStatusPending
    case 'probing':
      return S.batchStatusProbing
    case 'rendering':
      return S.batchStatusRendering
    case 'done':
      return S.batchStatusDone
    case 'error':
      return S.batchStatusError
    case 'skipped':
      return S.batchStatusSkipped
    default:
      return status
  }
}

export function BatchScreen({ onBack }: BatchScreenProps): JSX.Element {
  const [configs, setConfigs] = useState<EditorConfigMeta[]>([])
  const [configsLoading, setConfigsLoading] = useState(true)
  const [settings, setSettings] = useState<Settings | null>(null)

  const phase = useBatchStore((s) => s.phase)
  const items = useBatchStore((s) => s.items)
  const completed = useBatchStore((s) => s.completed)
  const failed = useBatchStore((s) => s.failed)
  const total = useBatchStore((s) => s.total)
  const summary = useBatchStore((s) => s.summary)
  const runError = useBatchStore((s) => s.error)
  const run = useBatchStore((s) => s.run)
  const cancel = useBatchStore((s) => s.cancel)
  const reset = useBatchStore((s) => s.reset)
  const text = useBatchStore((s) => s.draft.text)
  const configId = useBatchStore((s) => s.draft.configId)
  const applyTrim = useBatchStore((s) => s.draft.applyTrim)
  const setDraft = useBatchStore((s) => s.setDraft)

  const running = phase === 'running'

  const refreshConfigs = useCallback(async (): Promise<void> => {
    setConfigsLoading(true)
    try {
      const list = await window.shortz.listEditorConfigs()
      setConfigs(list)
      // Keep the selection valid as the list changes.
      const current = useBatchStore.getState().draft.configId
      if (!(current && list.some((c) => c.id === current))) {
        setDraft({ configId: list[0]?.id ?? '' })
      }
    } catch (err) {
      toast.err(`${S.errLoadConfig}: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setConfigsLoading(false)
    }
  }, [setDraft])

  useEffect(() => {
    void refreshConfigs()
    void window.shortz
      .getSettings()
      .then(setSettings)
      .catch(() => undefined)
  }, [refreshConfigs])

  const parsed = useMemo(() => parseBatchText(text), [text])
  const problems = useMemo<Problem[]>(
    () =>
      parsed
        .map((line) => {
          const message = lineProblemMessage(line)
          return message ? { line, message } : null
        })
        .filter((p): p is Problem => p !== null),
    [parsed]
  )

  // Renderable lines: parseable path + a hook the user actually typed.
  const renderable = useMemo(() => parsed.filter((l) => l.problems.length === 0), [parsed])
  const missingHooks = useMemo(
    () => renderable.filter((l) => l.hook.length === 0).length,
    [renderable]
  )

  const canStart =
    !running && renderable.length > 0 && problems.length === 0 && configId.length > 0

  const startDisabledReason = running
    ? S.batchStartTitle(renderable.length)
    : renderable.length === 0
      ? S.batchStartDisabled
      : problems.length > 0
        ? S.batchStartDisabled
        : configId.length === 0
          ? S.batchConfigNone
          : S.batchStartTitle(renderable.length)

  const start = async (): Promise<void> => {
    if (!canStart) return
    const payload: BatchRenderItem[] = renderable.map((line) => ({
      id: `line-${line.index}`,
      path: line.path,
      hook: line.hook
    }))
    await run({
      items: payload,
      configId,
      configTrim: applyTrim,
      ...(settings ? { outputDir: settings.output.dir } : {})
    })
  }

  const revealLast = async (): Promise<void> => {
    const last = Object.values(items)
      .map((i) => i.outputPath)
      .filter((p): p is string => typeof p === 'string')
      .pop()
    if (last) await window.shortz.revealInExplorer(last).catch(() => undefined)
    else if (settings?.output.dir) {
      await window.shortz.revealInExplorer(settings.output.dir).catch(() => undefined)
    }
  }

  const doneCount = summary ? summary.completed : completed
  const failedCount = summary ? summary.failed : failed
  const totalCount = summary ? summary.total : total || renderable.length

  return (
    <div className="batch">
      <header className="batch__topbar">
        <button type="button" className="btn btn-ghost" onClick={onBack} disabled={running}>
          <Icon name="arrowLeft" />
          {S.batchBack}
        </button>
        <div className="batch__chips">
          <span className="chip chip--name">{S.batch}</span>
          <span className="chip">
            {S.batchLinesSummary(renderable.length, parsed.length)}
          </span>
          {missingHooks > 0 && (
            <span className="chip chip--warn">{S.batchMissingHooks(missingHooks)}</span>
          )}
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canStart}
          title={startDisabledReason}
          onClick={() => void start()}
        >
          <Icon name="upload" />
          {S.batchStart}
        </button>
      </header>

      <div className="batch__panes">
        <section className="batch__input-pane">
          <h2 className="pane-title">{S.batchTitle}</h2>
          <p className="batch__intro">{S.batchIntro}</p>
          <code className="batch__example">{S.batchFormatExample}</code>

          <label className="field__label" htmlFor="batch-text">
            {S.batchInputLabel}
          </label>
          <textarea
            id="batch-text"
            className={`input batch__textarea${problems.length > 0 ? ' is-invalid' : ''}`}
            value={text}
            placeholder={S.batchInputPlaceholder}
            spellCheck={false}
            rows={14}
            disabled={running}
            onChange={(e) => {
              setDraft({ text: e.target.value })
              // A new edit invalidates the previous run's verdicts.
              if (phase === 'finished') reset()
            }}
          />

          {problems.length > 0 && (
            <div className="batch__problems" role="alert">
              {problems.slice(0, 8).map((p) => (
                <div key={p.line.index} className="batch__problem">
                  <span className="batch__problem-line">{S.batchProblemLine(p.line.lineNumber)}</span>
                  <span>{p.message}</span>
                </div>
              ))}
              {problems.length > 8 && (
                <div className="batch__problem-more">+{problems.length - 8} more</div>
              )}
            </div>
          )}

          <p className="field__hint">
            Separator: {BATCH_SEPARATOR} · extensions:{' '}
            {VIDEO_EXTENSIONS.slice(0, 6).join(', ')}…
          </p>

          <div className="field-panel__divider" role="presentation" />
          <h2 className="pane-title">{S.batchConfigTitle}</h2>

          <label className="field__label" htmlFor="batch-config">
            {S.batchConfigLabel}
          </label>
          <div className="batch__config-row">
            <select
              id="batch-config"
              className="input"
              value={configId}
              disabled={running || configsLoading || configs.length === 0}
              onChange={(e) => setDraft({ configId: e.target.value })}
            >
              {configs.length === 0 ? (
                <option value="">{S.batchConfigNone}</option>
              ) : (
                configs.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))
              )}
            </select>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              title={S.batchConfigReloadTitle}
              disabled={running}
              onClick={() => void refreshConfigs()}
            >
              <Icon name="refresh" size={14} />
              {S.batchConfigReload}
            </button>
          </div>
          <div className="field__hint">{S.batchConfigHint}</div>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={applyTrim}
              disabled={running}
              onChange={(e) => setDraft({ applyTrim: e.target.checked })}
            />
            {S.batchTrimToggle}
          </label>
          <div className="field__hint">{S.batchTrimHint}</div>

          {settings && (
            <div className="batch__output">
              <span className="field__label">{S.batchOutputLabel}</span>
              <code className="batch__output-path">{settings.output.dir}</code>
              <div className="field__hint">{S.batchOutputHint}</div>
            </div>
          )}
        </section>

        <section className="batch__queue-pane">
          <h2 className="pane-title">{S.batchQueueTitle}</h2>

          {parsed.length === 0 ? (
            <p className="batch__empty">{S.batchQueueEmpty}</p>
          ) : (
            <ul className="batch__list">
              {parsed.map((line) => {
                const problem = lineProblemMessage(line)
                const progress = items[line.index]
                const status = progress?.status ?? (problem ? 'skipped' : 'pending')
                const pct = progress?.percent ?? 0
                return (
                  <li
                    key={line.index}
                    className={`batch__item batch__item--${status}`}
                    title={problem ?? undefined}
                  >
                    <div className="batch__item-head">
                      <span className="batch__item-index">{line.index + 1}</span>
                      <span className="batch__item-name">{basenameOf(line.path) || '—'}</span>
                      <span className="batch__item-status">{statusLabel(problem ? 'skipped' : status)}</span>
                    </div>
                    <div className="batch__item-hook">
                      {line.hook.length > 0 ? (
                        line.hook
                      ) : (
                        <em className="batch__item-hook--empty">
                          {line.hasSeparator ? S.batchProblemEmptyHook : S.batchProblemNoSeparator}
                        </em>
                      )}
                    </div>
                    <div className="batch__item-meta">
                      <span className="batch__item-stem">{stemOf(line.path)}</span>
                      {line.lineNumber !== line.index + 1 && (
                        <span className="batch__item-lineno">
                          {S.batchProblemLine(line.lineNumber)}
                        </span>
                      )}
                    </div>
                    {problem && <div className="batch__item-problem">{problem}</div>}
                    {status === 'error' && progress?.error && (
                      <div className="batch__item-problem">{progress.error}</div>
                    )}
                    {status === 'done' && progress?.outputPath && (
                      <button
                        type="button"
                        className="batch__item-open"
                        onClick={() => void window.shortz.revealInExplorer(progress.outputPath as string)}
                      >
                        {S.batchRevealOutput}
                      </button>
                    )}
                    {(status === 'rendering' || status === 'probing') && (
                      <div className="batch__item-progress">
                        <div className="batch__item-progress-fill" style={{ width: `${pct}%` }} />
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </section>
      </div>

      {(running || summary || runError) && (
        <footer className="batch__bar" aria-live="polite">
          {running ? (
            <>
              <span className="batch__bar-label">
                {S.rendering} {S.batchProgressOf(Math.min(doneCount + failedCount + 1, totalCount), totalCount)}
              </span>
              <button type="button" className="btn btn-sm" onClick={() => void cancel()} title={S.batchCancelHint}>
                {S.batchCancel}
              </button>
            </>
          ) : runError ? (
            <>
              <span className="batch__bar-label batch__bar-label--err">{runError}</span>
              <button type="button" className="btn btn-sm" onClick={() => void revealLast()}>
                {S.batchRevealOutput}
              </button>
            </>
          ) : (
            <>
              <span className="batch__bar-label">
                {summary?.cancelled
                  ? S.batchCancelledToast
                  : failedCount > 0
                    ? S.batchFinishedWithErrors(doneCount, failedCount)
                    : S.batchFinishedToast(doneCount)}
              </span>
              <button type="button" className="btn btn-sm" onClick={() => void revealLast()}>
                {S.batchRevealOutput}
              </button>
            </>
          )}
        </footer>
      )}
    </div>
  )
}
