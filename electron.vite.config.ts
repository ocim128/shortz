import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// Renderer JSX is handled by esbuild directly (no @vitejs/plugin-react — kept
// out of the dependency budget per docs/03-tech-stack.md).
//
// Inputs are resolved against the project root (process.cwd()) — electron-vite
// resolves the renderer build entry from cwd, not from the renderer root, so
// relative inputs break `pnpm build` while working in `pnpm dev`.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: resolve('src/main/index.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: resolve('src/preload/index.ts')
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    esbuild: { jsx: 'automatic' },
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: resolve('src/renderer/index.html')
      }
    }
  }
})
