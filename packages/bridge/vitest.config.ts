import { defineConfig } from 'vitest/config'

/** Standalone test runner against the published DeepSeek Harness packages. */
export default defineConfig({
  test: {
      // The e2e suite boots a real browser and a real bridge in a hook. Vitest times
      // hooks separately from tests, and its 10s default is what failed the first CI
      // run, while every test in that suite already allowed 120s.
      hookTimeout: 120_000,
    include: ['tests/**/*.spec.ts'],
    setupFiles: ['tests/setup-invariant.ts'],
  },
})
