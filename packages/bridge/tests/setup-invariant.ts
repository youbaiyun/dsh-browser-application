/**
 * Load and execute the package's invariant companion so the coverage gate
 * measures it (the host SDK does this for every package via
 * scripts/test-invariants.ts). The stub registry runs the installer, matching
 * the real invariant service's behavior.
 */
import { apply } from '../src/invariant.ts'

void apply({
  invariants: {
    register: (_name: string, install: () => void) => {
      install()
      return () => {}
    },
  },
} as never)
