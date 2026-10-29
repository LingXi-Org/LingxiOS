import { fileURLToPath } from 'node:url'

/** Locate packaged assets independently of the application's working directory. */
export function packageResources() {
  return {
    schema: fileURLToPath(new URL('../../../db/schema.sql', import.meta.url)),
    /** Immutable native13 baseline for the explicit skill-delivery upgrade. */
    schema013: fileURLToPath(new URL('../../../db/schema-013.sql', import.meta.url)),
    migration016: fileURLToPath(new URL('../../../db/migrations/016-skill-delivery.sql', import.meta.url)),
    runner: fileURLToPath(new URL('../../../kernel/runner.py', import.meta.url)),
  }
}
