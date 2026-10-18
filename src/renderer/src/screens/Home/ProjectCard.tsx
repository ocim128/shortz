import { useEffect, useRef, useState } from 'react'
import type { ProjectMeta } from '../../../../preload/api'
import { formatRelativeAgo } from '../../lib/format'
import { S } from '../../strings'

interface ProjectCardProps {
  meta: ProjectMeta
  onOpen: (id: string) => void
  onRelink: (id: string) => void
  onDuplicate: (id: string) => void
  onDelete: (id: string) => void
  onReveal: (meta: ProjectMeta) => void
}

export function ProjectCard({ meta, onOpen, onRelink, onDuplicate, onDelete, onReveal }: ProjectCardProps): JSX.Element {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
    }
  }, [menu])

  const openMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    const rect = rootRef.current?.getBoundingClientRect()
    setMenu({ x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) })
  }

  return (
    <div
      ref={rootRef}
      className={`card project-card${meta.sourceMissing ? ' is-missing' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => (meta.sourceMissing ? onRelink(meta.id) : onOpen(meta.id))}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          if (meta.sourceMissing) onRelink(meta.id)
          else onOpen(meta.id)
        }
      }}
      onContextMenu={openMenu}
    >
      <div className="project-card__thumb">
        <span className="project-card__play" aria-hidden>
          ▶
        </span>
        {meta.sourceMissing && (
          <span className="project-card__missing-badge" title={S.homeRelinkPrompt}>
            ⚠ {S.homeRelink}
          </span>
        )}
      </div>
      <div className="project-card__name" title={meta.name}>
        {meta.name}
      </div>
      <div className="project-card__meta">
        {meta.templateId ? `${meta.templateId} · ` : ''}
        {formatRelativeAgo(meta.updatedAt)}
      </div>

      {menu && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(null)
              onDuplicate(meta.id)
            }}
          >
            {S.homeDuplicate}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(null)
              onReveal(meta)
            }}
          >
            {S.homeOpenLocation}
          </button>
          <button
            type="button"
            role="menuitem"
            className="ctx-menu__danger"
            onClick={() => {
              setMenu(null)
              onDelete(meta.id)
            }}
          >
            {S.homeDelete}
          </button>
        </div>
      )}
    </div>
  )
}
