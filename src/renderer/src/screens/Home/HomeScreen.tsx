import { useCallback, useRef, useState } from 'react'
import type { ProjectMeta } from '../../../../preload/api'
import { ProjectCard } from './ProjectCard'
import { Icon } from '../../components/Icon'
import { useProjectStore } from '../../stores/projectStore'
import { toast } from '../../stores/toastStore'
import { S } from '../../strings'

interface HomeScreenProps {
  onOpenSettings: () => void
  onOpenBatch: () => void
  onOpenDownloader: () => void
}

export function HomeScreen({
  onOpenSettings,
  onOpenBatch,
  onOpenDownloader
}: HomeScreenProps): JSX.Element {
  const list = useProjectStore((s) => s.list)
  const [dragOver, setDragOver] = useState(false)
  const dragDepth = useRef(0)

  const createFromFiles = useCallback(async (files: FileList | File[]) => {
    const file = Array.from(files)[0]
    if (!file) return
    const path = window.shortz.getPathForFile(file)
    if (!path) {
      toast.err(S.errCreateProject)
      return
    }
    try {
      await useProjectStore.getState().createFromSource(path)
    } catch (err) {
      toast.err(`${S.errCreateProject}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [])

  const browse = useCallback(async () => {
    const picked = await window.shortz.pickFile()
    if (picked) {
      try {
        await useProjectStore.getState().createFromSource(picked)
      } catch (err) {
        toast.err(`${S.errCreateProject}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }, [])

  const openProject = useCallback(async (id: string) => {
    try {
      await useProjectStore.getState().openProject(id)
    } catch (err) {
      toast.err(`${err instanceof Error ? err.message : String(err)}`)
    }
  }, [])

  const relink = useCallback(async (id: string) => {
    const picked = await window.shortz.pickFile()
    if (!picked) return
    try {
      await window.shortz.relinkSource(id, picked)
      await useProjectStore.getState().loadList()
      toast.ok(S.homeRelinked)
    } catch (err) {
      toast.err(`${S.errRelink}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [])

  // Duplicate: clone the document with the same source (createProject re-probes
  // and makes fresh assets). A re-probe failure (e.g. source vanished) surfaces
  // the real error.
  const duplicate = useCallback(async (id: string) => {
    try {
      const source = await window.shortz.openProject(id)
      await window.shortz.createProject(source.source.path)
      await useProjectStore.getState().loadList()
      toast.ok(S.homeDuplicated)
    } catch (err) {
      toast.err(`${S.errCreateProject}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [])

  const remove = useCallback(async (id: string) => {
    if (!window.confirm(S.homeDeleteConfirm)) return
    await window.shortz.deleteProject(id)
    await useProjectStore.getState().loadList()
  }, [])

  const reveal = useCallback(async (meta: ProjectMeta) => {
    try {
      const source = await window.shortz.openProject(meta.id)
      await window.shortz.revealInExplorer(source.source.path)
    } catch {
      toast.info(S.homeRevealMissing)
    }
  }, [])

  return (
    <div
      className={`home${dragOver ? ' is-dragover' : ''}`}
      onDragEnter={(e) => {
        e.preventDefault()
        dragDepth.current += 1
        setDragOver(true)
      }}
      onDragOver={(e) => e.preventDefault()}
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
        void createFromFiles(e.dataTransfer.files)
      }}
    >
      <header className="home__header">
        <div className="home__header-inner">
          <div className="home__logo">
            <span className="home__logo-mark" aria-hidden="true">
              <Icon name="play" size={12} />
            </span>
            {S.appName}
          </div>
          <div className="home__header-actions">
            <button type="button" className="btn btn-ghost" onClick={onOpenDownloader}>
              <Icon name="download" size={15} />
              {S.homeDownloader}
            </button>
            <button type="button" className="btn btn-ghost" onClick={onOpenBatch}>
              <Icon name="zap" size={15} />
              {S.homeBatch}
            </button>
            <button type="button" className="btn btn-ghost" onClick={onOpenSettings}>
              <Icon name="settings" size={15} />
              {S.homeSettings}
            </button>
          </div>
        </div>
      </header>

      <main className="home__main">
        <button type="button" className="dropzone" onClick={() => void browse()}>
          <span className="dropzone__icon" aria-hidden="true">
            <Icon name="film" size={26} />
          </span>
          <span className="dropzone__title">{S.homeDropTitle}</span>
          <span className="dropzone__hint">{S.homeDropHint}</span>
        </button>

        <section className="home__recent">
          <h2 className="home__recent-title">
            {S.homeRecent}
            {list.length > 0 && (
              <span className="home__recent-count" aria-hidden="true">
                {list.length}
              </span>
            )}
          </h2>
          {list.length === 0 ? (
            <div className="home__empty">
              <Icon name="film" size={22} aria-hidden="true" />
              <span>{S.homeNoProjects}</span>
            </div>
          ) : (
            <div className="home__grid">
              {list.map((meta) => (
                <ProjectCard
                  key={meta.id}
                  meta={meta}
                  onOpen={(id) => void openProject(id)}
                  onRelink={(id) => void relink(id)}
                  onDuplicate={(id) => void duplicate(id)}
                  onDelete={(id) => void remove(id)}
                  onReveal={(m) => void reveal(m)}
                />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
