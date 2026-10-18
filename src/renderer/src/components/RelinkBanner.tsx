import { Icon } from './Icon'
import { S } from '../strings'

/** RelinkBanner — shown when the project's source file is missing (failure table, docs/02-architecture.md). */
export function RelinkBanner({ onChoose }: { onChoose: () => void }): JSX.Element {
  return (
    <div className="relink-banner" role="alert">
      <span className="relink-banner__icon" aria-hidden>
        <Icon name="alert" size={16} />
      </span>
      <span className="relink-banner__text">{S.relinkBanner}</span>
      <button type="button" className="btn btn-sm" onClick={onChoose}>
        {S.relinkChoose}
      </button>
    </div>
  )
}
