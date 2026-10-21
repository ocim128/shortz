import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Generous for a real render on a slow machine, short enough that a hung
    // test fails in two minutes instead of five. Per-test overrides still win.
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
})
