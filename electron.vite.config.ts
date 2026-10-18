import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

// Renderer JSX is handled by esbuild directly (no @vitejs/plugin-react — kept
// out of the dependency budget per docs/03-tech-stack.md).
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      rollupOptions: {
        input: 'src/main/index.ts'
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: 'src/preload/index.ts'
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    esbuild: { jsx: 'automatic' },
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: 'index.html'
      }
    }
  }
})
