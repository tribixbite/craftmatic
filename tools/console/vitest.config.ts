/** Console-only vitest config: `bunx vitest run --root tools/console`. The repo's root config only globs test/**. */
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['**/*.test.ts'], testTimeout: 30000 } });
