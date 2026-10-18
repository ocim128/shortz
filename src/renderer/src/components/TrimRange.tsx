import { useCallback, useRef, useState } from 'react'
import { clamp, snapTenths } from '../lib/format'

/**
 * TrimRange — range handles under the playback bar; violet region = kept.
 * Snapping to 0.1 s; values shown on the handles (ui-spec §preview).
 */
interface TrimRangeProps {
  duration: number
  trim: { start: number; end: number }
  onChange: (trim: { start: number; end: number }) => void
}

type Handle = 'start' | 'end'

export function TrimRange({ duration, trim, onChange }: TrimRangeProps): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const [dragging, setDragging] = useState<Handle | null>(null)

  // {0,0} = trim disabled — display and drag against the full clip; any
  // handle drag activates trim at that range.
  const off = trim.end <= trim.start
  const eff = off ? { start: 0, end: duration } : trim

  const pct = useCallback(
    (t: number) => (duration > 0 ? clamp((t / duration) * 100, 0, 100) : 0),
    [duration]
  )

  const timeFromEvent = useCallback(
    (clientX: number): number => {
      const rect = trackRef.current?.getBoundingClientRect()
      if (!rect || duration <= 0) return 0
      const ratio = clamp((clientX - rect.left) / rect.width, 0, 1)
      return snapTenths(ratio * duration)
    },
    [duration]
  )

  const applyHandle = useCallback(
    (handle: Handle, t: number) => {
      if (handle === 'start') {
        onChange({ start: clamp(t, 0, eff.end - 0.1), end: eff.end })
      } else {
        onChange({ start: eff.start, end: clamp(t, eff.start + 0.1, duration) })
      }
    },
    [duration, onChange, eff.end, eff.start]
  )

  const onPointerDown = (handle: Handle) => (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    e.stopPropagation()
    setDragging(handle)
    trackRef.current?.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    applyHandle(dragging, timeFromEvent(e.clientX))
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragging) return
    applyHandle(dragging, timeFromEvent(e.clientX))
    trackRef.current?.releasePointerCapture(e.pointerId)
    setDragging(null)
  }

  const label = (t: number): string => `${t.toFixed(1)}s`

  // Value bubbles anchor flush near the track ends — centered bubbles on the
  // first/last 10% would paint past the track edge and get cut by the pane.
  const valueAnchor = (t: number): string => {
    const p = pct(t)
    if (p >= 90) return ' trim-range__value--flush-right'
    if (p <= 10) return ' trim-range__value--flush-left'
    return ''
  }

  return (
    <div className="trim-range">
      <div
        ref={trackRef}
        className={`trim-range__track${dragging ? ' is-dragging' : ''}`}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        role="presentation"
      >
        <div
          className="trim-range__region"
          style={{ left: `${pct(eff.start)}%`, width: `${Math.max(0, pct(eff.end) - pct(eff.start))}%` }}
        />
        <div
          className={`trim-range__handle${dragging === 'start' ? ' is-active' : ''}`}
          style={{ left: `${pct(eff.start)}%` }}
          onPointerDown={onPointerDown('start')}
          role="slider"
          tabIndex={0}
          aria-label="Trim start"
          aria-valuenow={eff.start}
          aria-valuemin={0}
          aria-valuemax={duration}
        >
          <span className={`trim-range__value${valueAnchor(eff.start)}`}>{label(eff.start)}</span>
        </div>
        <div
          className={`trim-range__handle${dragging === 'end' ? ' is-active' : ''}`}
          style={{ left: `${pct(eff.end)}%` }}
          onPointerDown={onPointerDown('end')}
          role="slider"
          tabIndex={0}
          aria-label="Trim end"
          aria-valuenow={eff.end}
          aria-valuemin={0}
          aria-valuemax={duration}
        >
          <span className={`trim-range__value${valueAnchor(eff.end)}`}>{label(eff.end)}</span>
        </div>
      </div>
    </div>
  )
}
