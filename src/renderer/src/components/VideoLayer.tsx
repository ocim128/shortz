import { useEffect, useRef } from 'react'
import { usePlayerStore } from '../stores/playerStore'
import { useProjectStore } from '../stores/projectStore'
import type { ResolvedLayout } from '../preview/layout'

/**
 * VideoLayer — the <video> element playing the original file directly through
 * the Range-capable media:// protocol (docs/02-architecture.md §preview
 * performance — no proxy in v0.1). Positioned in design-space px inside the
 * scaled phone frame; the store owns playback state.
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
    main.addEventListener('play', () => void bg.play().catch(() => {}))
    main.addEventListener('pause', () => bg.pause())
    return () => {
      main.removeEventListener('timeupdate', sync)
      main.removeEventListener('seeked', sync)
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
          borderRadius: layout.video.cornerRadius
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
          // First open: default the trim to the full clip.
          const p = useProjectStore.getState().active
          if (p && (p.trim.end <= 0 || p.trim.end > el.duration)) {
            useProjectStore.getState().patchActive((d) => {
              d.trim = { start: 0, end: Math.round(el.duration * 10) / 10 }
            })
          }
        }}
        onTimeUpdate={(e) => {
          const el = e.currentTarget
          setCurrent(el.currentTime)
          const { start, end } = trimRef.current
          if (end > 0 && el.currentTime >= end - 0.02) {
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
