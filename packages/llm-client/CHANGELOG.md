# Changelog

All notable changes to `@chisu/llm-client` will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — Iteration 1 (bootstrap)

- Package skeleton (`package.json`, `tsconfig.json`,
  `tsconfig.build.json`) matching the Foco monorepo ESM + `tsc`
  convention.
- `src/errors/taxonomy.ts`: `LLMCallError` discriminated union from
  `LLM_CLIENT.md §3.5` + `LLMErrorCode` helper + compact constructors.
- `src/errors/classify.ts`: pure classifiers `classifyProviderHttpError`,
  `classifyKmsError`, `classifyNetworkError` — implement the mapping
  table of `LLM_CLIENT.md §7.1`.
- `src/config/flag-defaults.ts`: `FLAG_DEFAULTS` frozen record of
  the 13 GrowthBook flags from `LLM_CLIENT.md §16`.
- `src/config/flag-validation.ts`: `validateFlags` (min/max +
  cross-invariants + hard-caps) and `loadFlagsWithFallback`
  (honours `LLM_CLIENT_ALLOW_FLAG_FALLBACK` env var for emergency
  recovery when GrowthBook is down).
- Unit test coverage for all of the above.

### Notes

- Build tool is `tsc` (not `tsup`). The plan in
  `project_foco_llm_client_implementation_plan` mentioned `tsup` for
  dual ESM/CJS; this iteration keeps `tsc` to match the rest of the
  monorepo (ESM-only). Revisit if/when `@chisu/llm-client` is
  published independently.
- License is proprietary. The package encodes Foco-specific plan
  pricing and the BYOK/Managed routing rules — not OSS material.

## [0.0.0] — 2026-04-18

- Package created. No runtime surface.
