import { usePlayerStore } from '../stores/playerStore'
import { formatTime } from '../lib/format'
import { Icon } from './Icon'
import { S } from '../strings'

/** Playback bar: play/pause (Space), current time, scrub (ui-spec §preview). */
export function PlaybackBar(): JSX.Element {
  const current = usePlayerStore((s) => s.current)
  const duration = usePlayerStore((s) => s.duration)
  const playing = usePlayerStore((s) => s.playing)
  const toggle = usePlayerStore((s) => s.toggle)
  const seek = usePlayerStore((s) => s.seek)

  const fill = duration > 0 ? Math.min(100, (current / duration) * 100) : 0

  return (
    <div className="playback-bar">
      <button
        type="button"
        className="btn btn-icon playback-bar__play"
        onClick={toggle}
        aria-label={playing ? S.pause : S.play}
        title={playing ? `${S.pause} (Space)` : `${S.play} (Space)`}
      >
        <Icon name={playing ? 'pause' : 'play'} size={15} />
      </button>
      <span className="playback-bar__time">
        {formatTime(current)} / {formatTime(duration)}
      </span>
      <input
        className="playback-bar__scrub"
        type="range"
        min={0}
        max={duration || 0}
        step={0.01}
        value={Math.min(current, duration || 0)}
        disabled={duration <= 0}
        onChange={(e) => seek(Number(e.target.value))}
        aria-label="Seek"
        style={{ '--fill': `${fill}%` } as React.CSSProperties}
      />
    </div>
  )
}
