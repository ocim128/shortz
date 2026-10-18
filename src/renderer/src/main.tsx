import { createRoot } from 'react-dom/client'
import { App } from './App'
import { useProjectStore } from './stores/projectStore'
import './tokens.css'
import './app.css'

createRoot(document.getElementById('root')!).render(<App />)

// Dev-only test hook (stripped from production builds by the dead-code pass):
// lets the CDP/Playwright harness drive the real Home → Editor flow without
// native dialogs.
if (import.meta.env.DEV) {
  Object.assign(window, {
    __shortzDev: {
      openPath: (p: string): Promise<unknown> => useProjectStore.getState().createFromSource(p)
    }
  })
}
