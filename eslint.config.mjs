import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TypeScript handles these via noUnusedLocals / noUnusedParameters
      '@typescript-eslint/no-unused-vars': 'off',
      // Allow explicit any in a few places (API responses, NBT parsing)
      '@typescript-eslint/no-explicit-any': 'warn',
      // Prefer const assertions and type narrowing
      'prefer-const': 'error',
      'no-var': 'error',
      // Disallow console.log in library code (use in CLI only)
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // Allow empty functions (common in default callbacks)
      '@typescript-eslint/no-empty-function': 'off',
      // Allow non-null assertions (used in grid access patterns)
      '@typescript-eslint/no-non-null-assertion': 'off',
      // False positives on init-then-conditional-assign patterns
      'no-useless-assignment': 'off',
    },
  },
  {
    // CLI and server files can use console.log
    files: ['src/cli.ts', 'src/render/server.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    ignores: ['dist/', 'web/', 'node_modules/', '**/*.js', '**/*.cjs'],
  },
);
