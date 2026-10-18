import { useEffect, useRef } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { useProjectStore } from '../stores/projectStore'
import type { ResolvedLayout } from '../../../shared/layout/engine'

/**
 * VideoLayer — the <video> element playing the original file directly through
 * the Range-capable media:// protocol (docs/02-architecture.md §preview
 * performance — no proxy in v0.1). Positioned in design-space px at the shared
 * engine's resolved geometry; the store owns playback state.
 */

interface VideoLayerProps {
  mediaUrl: string | null
  layout: ResolvedLayout
  muted: boolean
}

export function VideoLayer({ mediaUrl, layout, muted }: VideoLayerProps): JSX.Element | null {
  const videoRef = useRef<HTMLVideoElement>(null)
  const bgRef = useRef<HTMLVideoElement>(null)
  const attach = usePlayerStore((s) => s.attach)
  const setDuration = usePlayerStore((s) => s.setDuration)
  const setCurrent = usePlayerStore((s) => s.setCurrent)
  const setPlaying = usePlayerStore((s) => s.setPlaying)
  const setVideoSize = usePlayerStore((s) => s.setVideoSize)
  const setReady = usePlayerStore((s) => s.setReady)
  const setError = usePlayerStore((s) => s.setError)

  const trimEnd = useProjectStore((s) => s.active?.trim.end ?? 0)
  const trimStart = useProjectStore((s) => s.active?.trim.start ?? 0)
  const trimRef = useRef({ start: trimStart, end: trimEnd })
  trimRef.current = { start: trimStart, end: trimEnd }

  useEffect(() => {
    attach(videoRef.current)
    return () => attach(null)
  }, [attach])

  const blurBg = layout.canvas.background === 'blurVideo' && layout.video.w > 0

  // Keep the decorative blurred background copy loosely in sync with the main video.
  useEffect(() => {
    const main = videoRef.current
    const bg = bgRef.current
    if (!main || !bg) return
    const sync = (): void => {
      if (Math.abs(bg.currentTime - main.currentTime) > 0.2) bg.currentTime = main.currentTime
    }
    main.addEventListener('timeupdate', sync)
    main.addEventListener('seeked', sync)
    const onPlay = (): void => {
      void bg.play().catch(() => {})
    }
    const onPause = (): void => bg.pause()
    main.addEventListener('play', onPlay)
    main.addEventListener('pause', onPause)
    return () => {
      main.removeEventListener('timeupdate', sync)
      main.removeEventListener('seeked', sync)
      main.removeEventListener('play', onPlay)
      main.removeEventListener('pause', onPause)
    }
  }, [blurBg])

  if (!mediaUrl) return null

  return (
    <>
      {blurBg && (
        <video
          ref={bgRef}
          className="video-layer video-layer--blurbg"
          src={mediaUrl}
          muted
          playsInline
          preload="auto"
          aria-hidden
        />
      )}
      <video
        ref={videoRef}
        className="video-layer"
        style={{
          left: layout.video.x,
          top: layout.video.y,
          width: layout.video.w,
          height: layout.video.h,
          objectFit: layout.video.fit === 'cover' ? 'cover' : 'contain',
          borderRadius: layout.video.cornerRadius,
          ...(layout.video.borderWidth > 0
            ? { border: `${layout.video.borderWidth}px solid ${layout.video.borderColor}` }
            : {})
        }}
        src={mediaUrl}
        muted={muted}
        playsInline
        preload="auto"
        onLoadedMetadata={(e) => {
          const el = e.currentTarget
          setDuration(el.duration)
          setVideoSize(el.videoWidth, el.videoHeight)
          setReady(true)
          // Safety net for stale docs whose stored trim outlives the current
          // source (e.g. a legacy full-clip range after relink to a shorter
          // file) — clamp it. {0,0} is the documented "trim disabled" value
          // and must never be re-filled here.
          const p = useProjectStore.getState().active
          if (p && p.trim.end > el.duration) {
            const end = Math.floor(el.duration * 10) / 10
            useProjectStore.getState().patchActive((d) => {
              d.trim = d.trim.start < end ? { start: d.trim.start, end } : { start: 0, end: 0 }
            })
          }
        }}
        onTimeUpdate={(e) => {
          const el = e.currentTarget
          setCurrent(el.currentTime)
          const { start, end } = trimRef.current
          // Trim disabled ({0,0}) → loop at the clip's natural end instead.
          const loopEnd = end > start ? end : el.duration
          if (el.currentTime >= loopEnd - 0.02) {
            el.currentTime = start // loop within trim (ui-spec §preview)
          }
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onError={() => setError('Video failed to load')}
      />
    </>
  )
}
