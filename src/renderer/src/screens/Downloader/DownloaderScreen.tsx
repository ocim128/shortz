import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { DlListEntry, Settings } from '../../../../preload/api'
import type { DlLineProblemCode } from '../../../../shared/downloader/parse-run-input'
import { hasBlockingProblem, parseRunInput } from '../../../../shared/downloader/parse-run-input'
import { dlSkipText } from '../../../../shared/downloader/copy'
import { Icon } from '../../components/Icon'
import { formatBytes } from '../../lib/format'
import { useDlStore, type DlRow, type DlRun } from '../../stores/dlStore'
import { useProjectStore } from '../../stores/projectStore'
import { toast } from '../../stores/toastStore'
import { S } from '../../strings'

/**
 * DownloaderScreen — paste X status links, watch them resolve and download,
 * then send a finished file straight into the editor.
 *
 * The renderer previews with the same pure parser the core runs, sends every
 * line (duplicates and junk included) and renders main's authoritative verdict
 * per row key. It never composes an error sentence: rows show `item.error`,
 * phrased by main from copy.ts (AUDIT A7/A22).
 */

interface DownloaderScreenProps {
  onBack: () => void
  onOpenDownloadsSettings: () => void
  /** Settings is above this screen — Escape must close that first. */
  modalOpen: boolean
}

const TERMINAL_STATUSES = new Set(['ok', 'partial', 'failed', 'skipped', 'cancelled'])

function problemText(code: DlLineProblemCode): string {
  switch (code) {
    case 'no-link':
      return S.dlProblemNoLink
    case 'invalid-id':
      return S.dlProblemInvalidId
    case 'short-link':
      return S.dlProblemShortLink
    case 'duplicate':
      return S.dlProblemDuplicate
    case 'multiple-links':
      return S.dlProblemMultipleLinks
  }
}

/** First blocking problem, or the benign short-link note. */
function lineProblemText(line: { problems: DlLineProblemCode[] }): string | null {
  const blocking = line.problems.find((code) => code !== 'short-link')
  if (blocking !== undefined) return problemText(blocking)
  return line.problems.includes('short-link') ? problemText('short-link') : null
}

function statusLabel(row: DlRow): string {
  switch (row.status) {
    case 'queued':
      return S.dlStatusQueued
    case 'resolving':
      return S.dlStatusResolving
    case 'planned':
      return S.dlStatusPlanned
    case 'skipped':
      return S.dlStatusSkipped
    case 'downloading':
      return S.dlStatusDownloading
    case 'ok':
      return S.dlStatusOk
    case 'partial':
      return S.dlStatusPartial
    case 'failed':
      return S.dlStatusFailed
    case 'cancelled':
      return S.dlStatusCancelled
  }
}

function shortTweetId(tweetId: string): string {
  if (tweetId.length <= 6) return tweetId
  return `…${tweetId.slice(-4)}`
}

function basenameOf(filePath: string): string {
  const parts = filePath.split(/[\\/]/)
  return parts[parts.length - 1] ?? filePath
}

function mediaPercent(row: DlRow): number | null {
  const progress = row.progress
  if (!progress || progress.total === null || progress.total <= 0) return null
  return Math.max(0, Math.min(100, Math.round((progress.bytes / progress.total) * 100)))
}

function mediaBytes(row: DlRow): number {
  if (row.progress) return row.progress.bytes
  return (row.media ?? []).reduce((sum, media) => sum + media.bytes, 0)
}

function doneCount(run: DlRun): number {
  let count = 0
  for (const row of run.rows.values()) {
    if (TERMINAL_STATUSES.has(row.status)) count += 1
  }
  return count
}

function rowFile(row: DlRow): string | null {
  const files = row.files
  if (files && files.length > 0) return files[0] ?? null
  const planned = row.plannedPaths
  if (planned && planned.length > 0) return planned[0] ?? null
  return null
}

function runStateText(run: DlRun, phase: 'idle' | 'running' | 'finished'): string {
  const done = doneCount(run)
  const total = Math.max(run.itemTotal, run.rows.size)
  if (phase === 'running') {
    if (run.mode === 'analyze') return S.dlRunAnalyzing(Math.min(done + 1, total), total)
    if (run.mode === 'retry') return S.dlRunRetrying(Math.min(done + 1, total), total)
    return S.dlRunDownloading(Math.min(done + 1, total), total)
  }
  return run.summary ? S.dlRunSummary(run.summary) : ''
}

export function DownloaderScreen({
  onBack,
  onOpenDownloadsSettings,
  modalOpen
}: DownloaderScreenProps): JSX.Element {
  const text = useDlStore((s) => s.text)
  const setText = useDlStore((s) => s.setText)
  const phase = useDlStore((s) => s.phase)
  const run = useDlStore((s) => s.run)
  const history = useDlStore((s) => s.history)
  const start = useDlStore((s) => s.start)
  const analyze = useDlStore((s) => s.analyze)
  const retryFailed = useDlStore((s) => s.retryFailed)
  const cancel = useDlStore((s) => s.cancel)
  const openFolder = useDlStore((s) => s.openFolder)
  const loadHistory = useDlStore((s) => s.loadHistory)

  const [settings, setSettings] = useState<Settings | null>(null)
  const [menuKey, setMenuKey] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLPreElement>(null)

  const running = phase === 'running'

  useEffect(() => {
    void window.shortz
      .getSettings()
      .then(setSettings)
      .catch(() => undefined)
    void loadHistory()
  }, [loadHistory])

  // Refresh history when a run settles so the empty state is current.
  useEffect(() => {
    if (phase === 'finished') void loadHistory()
  }, [phase, loadHistory])

  useEffect(() => {
    if (!menuKey) return
    const close = (): void => setMenuKey(null)
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
    }
  }, [menuKey])

  // Escape closes an open row menu first, then leaves the screen (the spec's
  // "Escape/Back returns home"). A modal above the screen owns its own Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (menuKey) {
        setMenuKey(null)
        return
      }
      if (!modalOpen) onBack()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [menuKey, modalOpen, onBack])

  const parsed = useMemo(() => parseRunInput(text), [text])
  const problemLines = useMemo(() => parsed.filter((line) => line.problems.length > 0), [parsed])
  const linkCount = useMemo(() => parsed.filter((line) => line.url !== null).length, [parsed])
  const blockingCount = useMemo(
    () => parsed.filter((line) => hasBlockingProblem(line)).length,
    [parsed]
  )

  const lineNumbers = useMemo(() => {
    const count = Math.max(1, text.split(/\r?\n/).length)
    return Array.from({ length: count }, (_unused, i) => String(i + 1)).join('\n')
  }, [text])

  const canRun = !running && parsed.length > 0
  const rows = useMemo(() => {
    if (!run) return []
    return run.order
      .map((key) => run.rows.get(key))
      .filter((row): row is DlRow => row !== undefined)
  }, [run])

  const copyText = useCallback(async (value: string, message: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value)
      toast.ok(message)
    } catch (err) {
      toast.err(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const openAsProject = useCallback(async (filePath: string): Promise<void> => {
    try {
      await useProjectStore.getState().createFromSource(filePath)
    } catch (err) {
      toast.err(`${S.dlNewProjectError}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [])

  const reveal = useCallback(async (filePath: string): Promise<void> => {
    await window.shortz.revealInExplorer(filePath).catch(() => undefined)
  }, [])

  const fallbackOff = settings?.downloads.fallback === 'off'

  return (
    <div className="dl">
      <header className="dl__topbar">
        <button type="button" className="btn btn-ghost" onClick={onBack}>
          <Icon name="arrowLeft" />
          {S.dlBack}
        </button>
        <div className="dl__chips">
          <span className="chip chip--name">{S.downloader}</span>
          <span className="chip">{S.dlLinkSummary(linkCount, blockingCount)}</span>
          {running && <span className="chip chip--warn">{S.dlRunning}</span>}
        </div>
      </header>

      <div className="dl__panes">
        <section className="dl__input-pane">
          <h2 className="pane-title">{S.dlTitle}</h2>
          <p className="dl__intro">{S.dlIntro}</p>

          <div className={`dl__editor${running ? ' is-running' : ''}`}>
            <pre className="dl__gutter" ref={gutterRef} aria-hidden="true">
              {lineNumbers}
            </pre>
            <textarea
              ref={textareaRef}
              id="dl-text"
              className="input dl__textarea"
              value={text}
              placeholder={S.dlPlaceholder}
              spellCheck={false}
              readOnly={running}
              aria-label={S.dlTitle}
              onScroll={() => {
                if (gutterRef.current && textareaRef.current) {
                  gutterRef.current.scrollTop = textareaRef.current.scrollTop
                }
              }}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                  e.preventDefault()
                  if (canRun) void start()
                }
              }}
              onChange={(e) => setText(e.target.value)}
            />
          </div>

          {parsed.length > 0 && (
            <p className="dl__summary" aria-live="polite">
              {S.dlLinkSummary(linkCount, blockingCount)}
            </p>
          )}

          <div className="dl__verdicts">
            {problemLines.slice(0, 8).map((line) => (
              <div
                key={line.key}
                className={`dl__verdict${
                  hasBlockingProblem(line) ? ' dl__verdict--problem' : ' dl__verdict--info'
                }`}
              >
                <span className="dl__verdict-line">{S.dlProblemLine(line.lineNumber)}</span>
                <span>{lineProblemText(line)}</span>
              </div>
            ))}
            {problemLines.length > 8 && (
              <div className="dl__verdict-more">+{problemLines.length - 8}</div>
            )}
          </div>

          <div className="dl__toolbar">
            <button
              type="button"
              className="btn"
              disabled={!canRun}
              title={S.dlAnalyzeHint}
              onClick={() => void analyze()}
            >
              <Icon name="eye" size={14} />
              {S.dlAnalyze}
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!canRun}
              title={canRun ? S.dlDownloadHint : S.dlDownloadDisabled}
              onClick={() => void start()}
            >
              <Icon name="download" size={14} />
              {S.dlDownload}
            </button>
            <button
              type="button"
              className="btn"
              disabled={running}
              title={S.dlRetryHint}
              onClick={() => void retryFailed()}
            >
              {S.dlRetryFailed}
            </button>
            <button
              type="button"
              className="btn"
              disabled={!running}
              title={S.dlCancelHint}
              onClick={() => void cancel()}
            >
              {S.dlCancel}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => void openFolder()}>
              <Icon name="folderOpen" size={14} />
              {S.dlOpenFolder}
            </button>
          </div>
          <p className="field__hint">{S.dlDownloadHint}</p>
        </section>

        <section className="dl__run-pane">
          {run ? (
            <>
              <div className="dl__run-header">
                <span className="dl__run-label">
                  {S.dlRunLabel(run.jobId ? run.jobId.slice(0, 8) : '…')}
                </span>
                <span className={`dl__run-state${running ? ' is-live' : ''}`}>
                  {runStateText(run, phase)}
                </span>
              </div>

              <ul className="dl__list">
                {rows.map((row) => {
                  const percent = mediaPercent(row)
                  const size = mediaBytes(row)
                  const file = rowFile(row)
                  const firstFile = row.files?.[0] ?? null
                  const notEmbeddable = row.errorCode === 'NOT_EMBEDDABLE' && fallbackOff
                  return (
                    <li key={row.key} className={`dl-row dl-row--${row.status}`}>
                      <div className="dl-row__thumb">
                        {row.posterMediaUrl ? (
                          <img src={row.posterMediaUrl} alt="" draggable={false} />
                        ) : (
                          <Icon name="film" size={16} />
                        )}
                      </div>

                      <div className="dl-row__body">
                        <div className="dl-row__head">
                          <span className="dl-row__author">
                            {row.author ? `@${row.author}` : S.dlRowLine(row.lineNumber)}
                          </span>
                          {row.tweetId.length > 0 && (
                            <span className="dl-row__id" title={row.tweetId}>
                              {shortTweetId(row.tweetId)}
                            </span>
                          )}
                          <span className="dl-row__status">{statusLabel(row)}</span>
                        </div>

                        {row.caption && (
                          <div className="dl-row__caption" title={row.caption}>
                            {row.caption}
                          </div>
                        )}

                        {row.status === 'downloading' && (
                          <div className="dl-row__progress">
                            <div
                              className={`dl-row__progress-fill${percent === null ? ' is-indeterminate' : ''}`}
                              style={percent !== null ? { width: `${percent}%` } : undefined}
                            />
                            <span className="dl-row__progress-text">
                              {percent !== null ? S.dlPercent(percent) : ''}
                              {size > 0 ? ` · ${formatBytes(size)}` : ''}
                              {row.progress && row.progress.total
                                ? ` / ${formatBytes(row.progress.total)}`
                                : ''}
                              {row.media && row.media.length > 1
                                ? ` · ${S.dlMediaPosition(row.progress?.mediaIndex ?? 1, row.media.length)}`
                                : ''}
                            </span>
                          </div>
                        )}

                        {(row.status === 'ok' ||
                          row.status === 'partial' ||
                          row.status === 'planned') &&
                          (size > 0 || file !== null) && (
                            <div className="dl-row__meta">
                              {size > 0 && <span>{formatBytes(size)}</span>}
                              {row.media && row.media.length > 1 && (
                                <span>{S.dlMediaCount(row.media.length)}</span>
                              )}
                              {file && (
                                <span className="dl-row__file" title={file}>
                                  {basenameOf(file)}
                                </span>
                              )}
                            </div>
                          )}

                        {row.skipReason && (
                          <div className="dl-row__skip">{dlSkipText(row.skipReason)}</div>
                        )}

                        {row.error && (
                          <div
                            className="dl-row__error"
                            title={
                              row.errorCode
                                ? `${row.errorCode}${row.errorDetail ? `: ${row.errorDetail}` : ''}`
                                : undefined
                            }
                          >
                            {row.error}
                          </div>
                        )}

                        {notEmbeddable && (
                          <div className="dl-row__hint">
                            <Icon name="info" size={12} />
                            <span>{S.dlFallbackHint}</span>
                            <button
                              type="button"
                              className="dl-row__hint-link"
                              onClick={onOpenDownloadsSettings}
                            >
                              {S.dlFallbackSettings}
                            </button>
                          </div>
                        )}
                      </div>

                      <div className="dl-row__actions">
                        {firstFile !== null && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => void openAsProject(firstFile)}
                          >
                            {S.dlRowNewProject}
                          </button>
                        )}
                        <button
                          type="button"
                          className="icon-btn"
                          aria-label={S.dlRowMore}
                          title={S.dlRowMore}
                          onClick={(e) => {
                            e.stopPropagation()
                            setMenuKey((prev) => (prev === row.key ? null : row.key))
                          }}
                        >
                          ⋯
                        </button>

                        {menuKey === row.key && (
                          <div className="ctx-menu dl-row__menu" role="menu">
                            {file && (
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setMenuKey(null)
                                  void reveal(file)
                                }}
                              >
                                <Icon name="folderOpen" size={14} />
                                {S.dlRowReveal}
                              </button>
                            )}
                            {file && (
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setMenuKey(null)
                                  void copyText(file, S.dlCopiedPath)
                                }}
                              >
                                <Icon name="copy" size={14} />
                                {S.dlRowCopyPath}
                              </button>
                            )}
                            {row.tweetId.length > 0 && (
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setMenuKey(null)
                                  void copyText(
                                    `https://x.com/i/status/${row.tweetId}`,
                                    S.dlCopiedUrl
                                  )
                                }}
                              >
                                <Icon name="external" size={14} />
                                {S.dlRowCopyUrl}
                              </button>
                            )}
                          </div>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </>
          ) : (
            <>
              <div className="dl-empty">
                <span className="dl-empty__icon" aria-hidden="true">
                  <Icon name="download" size={22} />
                </span>
                <h2 className="dl-empty__title">{S.dlEmptyTitle}</h2>
                <p className="dl-empty__body">{S.dlEmptyBody}</p>
                <p className="dl-legal">{S.dlLegal}</p>
              </div>

              <section className="dl-recent">
                <h3 className="dl-recent__title">{S.dlRecentTitle}</h3>
                {history.length === 0 ? (
                  <p className="dl-recent__empty">{S.dlRecentEmpty}</p>
                ) : (
                  <ul className="dl-recent__list">
                    {history.slice(0, 8).map((entry) => (
                      <HistoryRow key={`${entry.tweetId}-${entry.downloadedAt}`} entry={entry} />
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}
        </section>
      </div>
    </div>
  )
}

function HistoryRow({ entry }: { entry: DlListEntry }): JSX.Element {
  const firstFile = entry.files[0]?.path
  const totalBytes = entry.files.reduce((sum, file) => sum + file.sizeBytes, 0)
  return (
    <li className="dl-recent__item">
      <div className="dl-recent__thumb">
        {entry.posterMediaUrl ? (
          <img src={entry.posterMediaUrl} alt="" draggable={false} />
        ) : (
          <Icon name="film" size={14} />
        )}
      </div>
      <div className="dl-recent__body">
        <span className="dl-recent__author">
          {entry.author ? `@${entry.author}` : entry.tweetId}
        </span>
        <span className="dl-recent__caption" title={entry.caption}>
          {entry.caption}
        </span>
      </div>
      <span className="dl-recent__size">{totalBytes > 0 ? formatBytes(totalBytes) : ''}</span>
      {firstFile && (
        <button
          type="button"
          className="icon-btn"
          aria-label={S.dlRowReveal}
          title={S.dlRowReveal}
          onClick={() => void window.shortz.revealInExplorer(firstFile).catch(() => undefined)}
        >
          <Icon name="folderOpen" size={14} />
        </button>
      )}
    </li>
  )
}
