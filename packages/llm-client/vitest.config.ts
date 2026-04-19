/**
 * Vitest config for `@chisu/llm-client`.
 *
 * Coverage thresholds are **enforced** (not aspirational): `pnpm test`
 * fails if any bar drops below. This is the invariant encoded in
 * `feedback_foco_quality.md` — "production-ready desde el primer
 * commit". If a threshold needs to drop, it should be a discussed
 * decision captured in the commit message, not a silent regression.
 *
 * Exclusions:
 *   - `src/types/**`             pure type shapes, no runtime
 *   - `src/** /index.ts`         barrel re-exports, no logic
 *   - `src/providers/provider.ts` interface + type declarations only
 *
 * Everything else is fair game — the crypto layer, the classifiers,
 * the three adapters, the HTTP transport, and the observability
 * helpers all have real branches that must be exercised.
 *
 * @see LLM_CLIENT.md §10 — Observability (the metric surface we must
 *      not regress on) and §9.4 — Provider invariants.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/types/**',
        'src/**/index.ts',
        'src/providers/provider.ts',
      ],
      thresholds: {
        statements: 90,
        branches: 85,
        functions: 90,
        lines: 90,
      },
    },
  },
});
