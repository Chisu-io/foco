// @ts-check
/**
 * Foco — root ESLint flat config (ESLint 9).
 *
 * Applies to every package in the monorepo via the workspace-level
 * `pnpm lint` / `turbo run lint` pipelines. Each package inherits this
 * config automatically because `eslint .` walks up from the package cwd.
 *
 * Design goals:
 *  - Type-aware linting powered by typescript-eslint's `projectService`
 *    so new `tsconfig.json` files are picked up without hand-wiring.
 *  - Strict by default; loosened only where the ergonomic cost is high
 *    (tests, build tooling, generated files).
 *  - Prettier owns formatting. ESLint only enforces correctness and style
 *    that Prettier cannot express.
 */

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier/flat';
import importX from 'eslint-plugin-import-x';
import { createTypeScriptImportResolver } from 'eslint-import-resolver-typescript';
import globals from 'globals';

export default tseslint.config(
  // ------------------------------------------------------------------
  // Global ignores — must be the first config block.
  // ------------------------------------------------------------------
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/.next/**',
      '**/.vercel/**',
      '**/pnpm-lock.yaml',
      // Generated/ambient type output
      '**/*.d.ts',
    ],
  },

  // ------------------------------------------------------------------
  // Base ESLint recommendations for all JS/TS.
  // ------------------------------------------------------------------
  js.configs.recommended,

  // ------------------------------------------------------------------
  // TypeScript: strict + stylistic, both type-checked.
  // These expand to multiple config objects under the hood.
  // ------------------------------------------------------------------
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  // ------------------------------------------------------------------
  // Project-wide language + plugin settings for TS source files.
  // ------------------------------------------------------------------
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
      globals: {
        ...globals.node,
        ...globals.es2024,
      },
    },
    plugins: {
      'import-x': importX,
    },
    settings: {
      'import-x/resolver-next': [
        createTypeScriptImportResolver({
          alwaysTryTypes: true,
          project: ['packages/*/tsconfig.json', 'apps/*/tsconfig.json'],
        }),
        importX.createNodeResolver(),
      ],
    },
    rules: {
      // ---- Correctness -----------------------------------------------
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unnecessary-condition': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',

      // ---- Ergonomics for a fresh codebase ---------------------------
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/consistent-type-exports': 'error',
      '@typescript-eslint/prefer-nullish-coalescing': 'error',
      '@typescript-eslint/prefer-optional-chain': 'error',
      '@typescript-eslint/prefer-readonly': 'error',

      // ---- Imports ---------------------------------------------------
      'import-x/no-cycle': ['error', { maxDepth: 5 }],
      'import-x/no-self-import': 'error',
      'import-x/no-useless-path-segments': 'error',
      'import-x/order': [
        'error',
        {
          groups: [
            'builtin',
            'external',
            'internal',
            ['parent', 'sibling', 'index'],
            'object',
            'type',
          ],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
    },
  },

  // ------------------------------------------------------------------
  // Tests: relax the strictest rules that don't pay off in test code.
  // ------------------------------------------------------------------
  {
    files: ['**/*.{test,spec}.{ts,tsx}', '**/__tests__/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  // ------------------------------------------------------------------
  // Build / tooling configs (plain JS, no type-aware linting).
  // ------------------------------------------------------------------
  {
    files: ['**/*.config.{js,mjs,cjs}', '**/vitest.config.{js,mjs,cjs,ts}', 'eslint.config.js'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },

  // ------------------------------------------------------------------
  // Prettier must be last. Disables rules that fight formatting.
  // ------------------------------------------------------------------
  prettier,
);
