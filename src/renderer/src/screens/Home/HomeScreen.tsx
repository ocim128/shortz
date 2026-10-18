import { useCallback, useRef, useState } from 'react'
import type { ProjectMeta } from '../../../../preload/api'
import { ProjectCard } from './ProjectCard'
import { useProjectStore } from '../../stores/projectStore'
import { toast } from '../../stores/toastStore'
import { S } from '../../strings'

interface HomeScreenProps {
  onOpenSettings: () => void
}

export function HomeScreen({ onOpenSettings }: HomeScreenProps): JSX.Element {
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

  const duplicate = useCallback(
    async (id: string) => {
      // Mocked: real duplication lands with the project store core.
      void id
      toast.info(S.mockOnlyToast)
    },
    []
  )

  const remove = useCallback(async (id: string) => {
    if (!window.confirm(S.homeDeleteConfirm)) return
    await window.shortz.deleteProject(id)
    await useProjectStore.getState().loadList()
  }, [])

  const reveal = useCallback(
    async (meta: ProjectMeta) => {
      // The mocked store keeps no on-disk project file; reveal the source folder
      // shape is unknown for missing sources — surface as mocked for now.
      void meta
      toast.info(S.mockOnlyToast)
    },
    []
  )

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
        <div className="home__logo">{S.appName}</div>
        <button type="button" className="btn btn-ghost" onClick={onOpenSettings}>
          {S.homeSettings}
        </button>
      </header>

      <main className="home__main">
        <button type="button" className="dropzone" onClick={() => void browse()}>
          <div className="dropzone__title">{S.homeDropTitle}</div>
          <div className="dropzone__hint">{S.homeDropHint}</div>
        </button>

        <section className="home__recent">
          <h2 className="home__recent-title">{S.homeRecent}</h2>
          {list.length === 0 ? (
            <p className="home__empty">{S.homeNoProjects}</p>
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
