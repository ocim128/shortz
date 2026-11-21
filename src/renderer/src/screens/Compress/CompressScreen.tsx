import { useEffect, useRef, useState } from 'react'
import { isVideoExtension } from '../../../../shared/video-extensions'
import { Icon } from '../../components/Icon'
import { formatBytes } from '../../lib/format'
import { S } from '../../strings'

type Quality = 'high' | 'balanced' | 'small'
type Result = { path: string; originalBytes: number; sizeBytes: number }

export function CompressScreen({ onBack }: { onBack: () => void }): JSX.Element {
  const [source, setSource] = useState('')
  const [quality, setQuality] = useState<Quality>('balanced')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const dragDepth = useRef(0)

  useEffect(() => window.shortz.onCompressionProgress(setProgress), [])

  const selectSource = (file: string): void => {
    setSource(file)
    setResult(null)
    setError('')
  }
  const choose = async (): Promise<void> => {
    const file = await window.shortz.pickFile()
    if (file) selectSource(file)
  }
  const start = async (): Promise<void> => {
    if (!source || running) return
    setRunning(true)
    setProgress(0)
    setResult(null)
    setError('')
    try {
      setResult(await window.shortz.compressVideo(source, quality))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div
      className={`batch${dragOver ? ' is-dragover' : ''}`}
      onDragEnter={(e) => {
        e.preventDefault()
        if (running || !Array.from(e.dataTransfer.types).includes('Files')) return
        dragDepth.current += 1
        setDragOver(true)
      }}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = running ? 'none' : 'copy'
      }}
      onDragLeave={() => {
        dragDepth.current -= 1
        if (dragDepth.current <= 0) {
          dragDepth.current = 0
          setDragOver(false)
        }
      }}
      onDrop={(e) => {
        e.preventDefault()
        dragDepth.current = 0
        setDragOver(false)
        if (running) return
        const file = e.dataTransfer.files[0]
        if (!file) return
        const extension = file.name.includes('.') ? file.name.split('.').pop() : ''
        if (!extension || !isVideoExtension(extension)) {
          setError(S.compressInvalidFile)
          return
        }
        const path = window.shortz.getPathForFile(file)
        if (!path) {
          setError(S.compressMissingPath)
          return
        }
        selectSource(path)
      }}
    >
      <header className="batch__topbar">
        <button type="button" className="btn btn-ghost" onClick={onBack} disabled={running}>
          <Icon name="arrowLeft" /> {S.back}
        </button>
        <div className="batch__chips">
          <span className="chip chip--name">{S.homeCompress}</span>
        </div>
      </header>
      <main className="compress__content">
        <h2 className="pane-title">{S.homeCompress}</h2>
        <p className="batch__intro">{S.compressIntro}</p>
        <button
          type="button"
          className="dropzone compress__dropzone"
          onClick={() => void choose()}
          disabled={running}
        >
          <span className="dropzone__icon" aria-hidden="true">
            <Icon name="film" size={26} />
          </span>
          <span className="dropzone__title">{S.homeDropTitle}</span>
          <span className="dropzone__hint">{S.homeDropHint}</span>
        </button>
        {source && (
          <p className="compress__path" title={source}>
            {source}
          </p>
        )}
        <label className="field__label" htmlFor="compress-quality">
          {S.compressQuality}
        </label>
        <select
          id="compress-quality"
          className="input"
          value={quality}
          disabled={running}
          onChange={(e) => setQuality(e.target.value as Quality)}
        >
          <option value="high">{S.compressHigh}</option>
          <option value="balanced">{S.compressBalanced}</option>
          <option value="small">{S.compressSmall}</option>
        </select>
        <div className="compress__actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!source || running}
            onClick={() => void start()}
          >
            {S.compressStart}
          </button>
          {running && (
            <button
              type="button"
              className="btn"
              onClick={() => void window.shortz.cancelCompression()}
            >
              {S.cancelExport}
            </button>
          )}
        </div>
        {running && (
          <div role="status">
            <p>
              {S.compressRunning} {Math.round(progress)}%
            </p>
            <progress max="100" value={progress} />
          </div>
        )}
        {error && (
          <p role="alert">
            {S.compressError}: {error}
          </p>
        )}
        {result && (
          <div role="status" className="card compress__result">
            <strong>{S.compressResult}</strong>
            <p>
              {formatBytes(result.originalBytes)} → {formatBytes(result.sizeBytes)}
              {result.sizeBytes < result.originalBytes
                ? ` (${Math.round((1 - result.sizeBytes / result.originalBytes) * 100)}% smaller)`
                : ''}
            </p>
            {result.sizeBytes >= result.originalBytes && <p>{S.compressSizeWarning}</p>}
            <p className="compress__path" title={result.path}>
              {result.path}
            </p>
            <button
              type="button"
              className="btn"
              onClick={() => void window.shortz.revealInExplorer(result.path)}
            >
              {S.batchRevealOutput}
            </button>
          </div>
        )}
      </main>
    </div>
  )
}
