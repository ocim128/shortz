import { useCallback, useEffect, useState } from 'react'
import { EditorScreen } from './screens/Editor/EditorScreen'
import { BatchScreen } from './screens/Batch/BatchScreen'
import { DownloaderScreen } from './screens/Downloader/DownloaderScreen'
import { HomeScreen } from './screens/Home/HomeScreen'
import { SettingsModal } from './components/SettingsModal'
import { ToastStack } from './components/Toast'
import { loadBundledFonts } from './preview/font-loader'
import { useProjectStore } from './stores/projectStore'
import { subscribeRenderProgress } from './stores/renderStore'
import { subscribeBatchProgress } from './stores/batchStore'
import { subscribeDlProgress } from './stores/dlStore'
import { toast } from './stores/toastStore'
import { S } from './strings'

type Screen = 'home' | 'editor' | 'batch' | 'downloader'

export function App(): JSX.Element {
  const active = useProjectStore((s) => s.active)
  const [settingsOpen, setSettingsOpen] = useState(false)
  // Deep link target: the Downloader's NOT_EMBEDDABLE hint opens Settings on
  // the Downloads group instead of the top of the modal.
  const [settingsSection, setSettingsSection] = useState<'downloads' | null>(null)
  const [screen, setScreen] = useState<Screen>('home')

  const openSettings = useCallback((section: 'downloads' | null = null) => {
    setSettingsSection(section)
    setSettingsOpen(true)
  }, [])

  const handleNewProject = useCallback(async () => {
    const picked = await window.shortz.pickFile()
    if (!picked) return
    try {
      await useProjectStore.getState().createFromSource(picked)
    } catch (err) {
      toast.err(`${S.errCreateProject}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }, [])

  useEffect(() => {
    void loadBundledFonts()
    void useProjectStore.getState().loadList()
    const unsubRender = subscribeRenderProgress()
    const unsubBatch = subscribeBatchProgress()
    const unsubDl = subscribeDlProgress()
    const unsubMenu = window.shortz.onMenuCommand((cmd) => {
      if (cmd === 'open-settings') openSettings(null)
      if (cmd === 'new-project') void handleNewProject()
    })

    // Global guard: a file dropped outside a drop zone must not navigate the
    // window to file:// (default Chromium behavior).
    const preventNav = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('dragover', preventNav)
    window.addEventListener('drop', preventNav)

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setSettingsOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)

    return () => {
      unsubRender()
      unsubBatch()
      unsubDl()
      unsubMenu()
      window.removeEventListener('dragover', preventNav)
      window.removeEventListener('drop', preventNav)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [handleNewProject, openSettings])

  return (
    <div className="app">
      {active ? (
        <EditorScreen />
      ) : screen === 'batch' ? (
        <BatchScreen onBack={() => setScreen('home')} />
      ) : screen === 'downloader' ? (
        <DownloaderScreen
          onBack={() => setScreen('home')}
          onOpenDownloadsSettings={() => openSettings('downloads')}
        />
      ) : (
        <HomeScreen
          onOpenSettings={() => openSettings(null)}
          onOpenBatch={() => setScreen('batch')}
          onOpenDownloader={() => setScreen('downloader')}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          {...(settingsSection ? { initialSection: settingsSection } : {})}
        />
      )}
      <ToastStack />
    </div>
  )
}
