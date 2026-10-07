import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.json'] })],
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    // The worker-boot specs are ~370ms each when run alone, and the suite runs every
    // file in parallel; the default five seconds is thin for the slowest of them on a
    // loaded machine. A test that genuinely hangs still fails, just later.
    testTimeout: 15_000,
    setupFiles: ['tests/setup.ts'],
  },
})
