import { useCallback, useEffect, useState } from 'react'
import { EditorScreen } from './screens/Editor/EditorScreen'
import { BatchScreen } from './screens/Batch/BatchScreen'
import { HomeScreen } from './screens/Home/HomeScreen'
import { SettingsModal } from './components/SettingsModal'
import { ToastStack } from './components/Toast'
import { loadBundledFonts } from './preview/font-loader'
import { useProjectStore } from './stores/projectStore'
import { subscribeRenderProgress } from './stores/renderStore'
import { subscribeBatchProgress } from './stores/batchStore'
import { toast } from './stores/toastStore'
import { S } from './strings'

type Screen = 'home' | 'editor' | 'batch'

export function App(): JSX.Element {
  const active = useProjectStore((s) => s.active)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [screen, setScreen] = useState<Screen>('home')

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
    const unsubMenu = window.shortz.onMenuCommand((cmd) => {
      if (cmd === 'open-settings') setSettingsOpen(true)
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
      unsubMenu()
      window.removeEventListener('dragover', preventNav)
      window.removeEventListener('drop', preventNav)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [handleNewProject])

  return (
    <div className="app">
      {active ? (
        <EditorScreen />
      ) : screen === 'batch' ? (
        <BatchScreen onBack={() => setScreen('home')} />
      ) : (
        <HomeScreen onOpenSettings={() => setSettingsOpen(true)} onOpenBatch={() => setScreen('batch')} />
      )}
      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
      <ToastStack />
    </div>
  )
}
