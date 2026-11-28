import { useEffect, useRef, useState } from 'react'
import type { TtsResult } from '../../../../preload/api'
import { Icon } from '../../components/Icon'
import { formatBytes } from '../../lib/format'
import { S } from '../../strings'
import {
  TTS_MAX_TEXT_LENGTH,
  VOICE_PRESETS
} from '../../../../shared/tts/voices'
import { ARCHIPELAGO_EN_VOICE, ARCHIPELAGO_VOICE, INVESTIGATOR_VOICE_ID, INVESTIGATOR_VOICE } from '../../../../shared/tts/gemini'

const SPEECH_VOICES = [INVESTIGATOR_VOICE, ARCHIPELAGO_VOICE, ARCHIPELAGO_EN_VOICE, ...VOICE_PRESETS]

type PreviewState = 'idle' | 'loading' | 'ready' | 'error'

/** Default output name: first sentence, capped, without trailing punctuation. */
function defaultFilename(text: string): string {
  const first = (text.trim().split(/[.!?\n…]/)[0] ?? '').trim()
  return first.length > 0 ? first.slice(0, 40) : ''
}

export function SpeechScreen({ onBack }: { onBack: () => void }): JSX.Element {
  const [text, setText] = useState('')
  const [voiceId, setVoiceId] = useState<string>(INVESTIGATOR_VOICE_ID)
  const [filename, setFilename] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<TtsResult | null>(null)
  const [error, setError] = useState('')
  const [previewError, setPreviewError] = useState('')
  const [previewState, setPreviewState] = useState<Record<string, PreviewState>>({})
  const [previewUrl, setPreviewUrl] = useState<Record<string, string>>({})
  const [playingId, setPlayingId] = useState<string | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const previewBusyRef = useRef(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)

  // Stop any preview audio when leaving the screen.
  useEffect(
    () => () => {
      audioRef.current?.pause()
      audioRef.current = null
    },
    []
  )

  const playPreview = async (id: string): Promise<void> => {
    if (running || previewBusyRef.current) return
    if (playingId === id && audioRef.current) {
      audioRef.current.pause()
      setPlayingId(null)
      return
    }
    audioRef.current?.pause()
    setPlayingId(null)
    setPreviewError('')
    try {
      let url = previewUrl[id]
      if (!url) {
        previewBusyRef.current = true
        setPreviewLoading(true)
        setPreviewState((s) => ({ ...s, [id]: 'loading' }))
        const fresh = await window.shortz.ttsPreviewVoice(id)
        setPreviewUrl((s) => ({ ...s, [id]: fresh }))
        setPreviewState((s) => ({ ...s, [id]: 'ready' }))
        url = fresh
      }
      const audio = new Audio(url)
      audioRef.current = audio
      setPlayingId(id)
      audio.onended = () => {
        if (audioRef.current === audio) setPlayingId(null)
      }
      audio.onerror = () => {
        if (audioRef.current === audio) setPlayingId(null)
      }
      await audio.play()
    } catch (err) {
      console.warn('tts preview failed:', err)
      setPreviewError(err instanceof Error ? err.message : String(err))
      setPreviewState((s) => ({ ...s, [id]: 'error' }))
      setPlayingId(null)
    } finally {
      previewBusyRef.current = false
      setPreviewLoading(false)
    }
  }

  const start = async (): Promise<void> => {
    if (!text.trim() || running) return
    setRunning(true)
    setResult(null)
    setError('')
    try {
      setResult(
        await window.shortz.ttsSynthesize({
          text,
          voiceId,
          ...(filename.trim() ? { filename: filename.trim() } : {})
        })
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRunning(false)
    }
  }

  const previewLabel = (id: string): string => {
    if (previewState[id] === 'loading') return S.ttsPreviewLoading
    if (playingId === id) return S.ttsPreviewPause
    return S.ttsPreview
  }

  return (
    <div className="batch">
      <header className="batch__topbar">
        <button type="button" className="btn btn-ghost" onClick={onBack} disabled={running || previewLoading}>
          <Icon name="arrowLeft" /> {S.back}
        </button>
        <div className="batch__chips">
          <span className="chip chip--name">{S.homeSpeech}</span>
        </div>
      </header>
      <main className="compress__content speech__content">
        <h2 className="pane-title">{S.homeSpeech}</h2>
        <p className="batch__intro">{S.ttsIntro}</p>

        <label className="field__label" htmlFor="tts-text">
          {S.ttsTextLabel}
        </label>
        <textarea
          id="tts-text"
          className="input speech__text"
          value={text}
          placeholder={S.ttsTextPlaceholder}
          rows={7}
          maxLength={TTS_MAX_TEXT_LENGTH * 2}
          disabled={running}
          onChange={(e) => setText(e.target.value)}
        />
        <p className={text.length > TTS_MAX_TEXT_LENGTH ? 'speech__chars is-over' : 'speech__chars'}>
          {S.ttsCharsCount(text.trim().length, TTS_MAX_TEXT_LENGTH)}
        </p>

        <span className="field__label">{S.ttsVoiceLabel}</span>
        <p className="speech__voice-tag">{S.ttsVoiceTag(SPEECH_VOICES.length)}</p>
        <div className="speech__voices" role="radiogroup" aria-label={S.ttsVoiceLabel}>
          {SPEECH_VOICES.map((v) => {
            const selected = v.id === voiceId
            const state = previewState[v.id] ?? 'idle'
            return (
              <div
                key={v.id}
                className={`speech__voice${selected ? ' is-selected' : ''}${state === 'error' ? ' is-error' : ''}`}
              >
                <label className="speech__voice-choice">
                  <input
                    type="radio"
                    name="tts-voice"
                    value={v.id}
                    checked={selected}
                    disabled={running}
                    onChange={() => setVoiceId(v.id)}
                  />
                  <span className="speech__voice-body">
                    <span className="speech__voice-name">{v.name}</span>
                    <span className="speech__voice-desc">{v.description}</span>
                  </span>
                </label>
                <button
                  type="button"
                  className="btn btn-ghost"
                  disabled={running || previewLoading}
                  aria-label={`${previewLabel(v.id)} ${v.name}`}
                  onClick={() => void playPreview(v.id)}
                >
                  <Icon name={playingId === v.id ? 'pause' : 'play'} size={13} />
                  {previewLabel(v.id)}
                </button>
              </div>
            )
          })}
        </div>
        {previewLoading && (
          <button type="button" className="btn" onClick={() => void window.shortz.ttsCancel()}>
            Cancel preview
          </button>
        )}
        {previewError && <p role="alert">{S.ttsPreviewFailed}: {previewError}</p>}

        <label className="field__label" htmlFor="tts-filename">
          {S.ttsFilenameLabel}
        </label>
        <input
          id="tts-filename"
          className="input speech__filename"
          type="text"
          value={filename}
          placeholder={defaultFilename(text) || S.ttsFilenamePlaceholder}
          disabled={running}
          onChange={(e) => setFilename(e.target.value)}
        />

        <div className="compress__actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!text.trim() || text.trim().length > TTS_MAX_TEXT_LENGTH || running || previewLoading}
            onClick={() => void start()}
          >
            {S.ttsGenerate}
          </button>
          {running && (
            <button type="button" className="btn" onClick={() => void window.shortz.ttsCancel()}>
              {S.ttsCancel}
            </button>
          )}
        </div>

        {running && (
          <div role="status">
            <p>{S.ttsRunning}</p>
          </div>
        )}
        {error && (
          <p role="alert">
            {S.ttsError}: {error}
          </p>
        )}
        {result && (
          <div role="status" className="card compress__result">
            <strong>{result.verified === false ? S.ttsReviewRequired : S.ttsResult}</strong>
            {result.verified === false && <p>{S.ttsReviewDetails}</p>}
            <p>{formatBytes(result.bytes)}</p>
            <audio controls preload="none" src={result.url} className="speech__player" />
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
            {result.reportPath && (
              <button type="button" className="btn" onClick={() => void window.shortz.revealInExplorer(result.reportPath!)}>
                {S.ttsRevealReport}
              </button>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
