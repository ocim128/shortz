import { useEffect, useRef, useState } from 'react'
import type { ProjectMeta } from '../../../../preload/api'
import { Icon } from '../../components/Icon'
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
  const [thumbUrl, setThumbUrl] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  // media:// URL for projects/<id>/thumb.jpg when the asset exists.
  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const url = await window.shortz.getThumbUrl(meta.id)
        if (alive) setThumbUrl(url)
      } catch {
        /* missing thumb keeps the fallback glyph */
      }
    }
    void load()
    return () => {
      alive = false
    }
  }, [meta.id])

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const openMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    const rect = rootRef.current?.getBoundingClientRect()
    setMenu({ x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) })
  }

  const activate = (): void => {
    if (meta.sourceMissing) onRelink(meta.id)
    else onOpen(meta.id)
  }

  return (
    <div
      ref={rootRef}
      className={`card project-card${meta.sourceMissing ? ' is-missing' : ''}`}
      role="button"
      tabIndex={0}
      onClick={activate}
      onKeyDown={(e) => {
        // role=button promises both Enter and Space activation.
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          activate()
        }
      }}
      onContextMenu={openMenu}
    >
      <div className="project-card__thumb">
        {thumbUrl ? (
          <img className="project-card__thumb-img" src={thumbUrl} alt="" draggable={false} />
        ) : (
          <span className="project-card__play" aria-hidden="true">
            <Icon name="play" size={18} />
          </span>
        )}
        {meta.sourceMissing && (
          <span className="project-card__missing-badge" title={S.homeRelinkPrompt}>
            <Icon name="alert" size={11} />
            {S.homeRelink}
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
            <Icon name="copy" size={14} />
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
            <Icon name="folderOpen" size={14} />
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
            <Icon name="trash" size={14} />
            {S.homeDelete}
          </button>
        </div>
      )}
    </div>
  )
}
