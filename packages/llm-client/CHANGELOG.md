# Changelog

All notable changes to `@chisu/llm-client` will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — Iteration 2 (envelope encryption)

- `src/crypto/sharding.ts`: `shardCountFor(kekVersion)` (function, not
  constant — extension point for §5.3 rebalance) and `shardId(userId,
  kekVersion)` using SHA-256 + BigInt mod for unbiased uniform
  distribution. `v1` registered with `N = 8` (capacity ≈8 000 users,
  power of two). `knownKekVersions()` for the rebalance runbook.
- `src/crypto/dek.ts`: AES-256-GCM primitives — `generateDek`,
  `encryptWithDek`, `decryptWithDek`, plus `zeroize(Buffer|Uint8Array)`.
  Nonce is 12 bytes, auth tag is 16 bytes; defensive assertions against
  wrong sizes. Pure (no I/O, no KMS).
- `src/crypto/kek.ts`: `@aws-sdk/client-kms` v3 wrappers `kmsEncrypt` /
  `kmsDecrypt` with the canonical alias `alias/foco/kek/v${v}/shard-${s}`.
  `KMSClient` is dependency-injected (no custom wrapper) so
  `aws-sdk-client-mock` can substitute it cleanly in tests. Hard-capped
  retry budget `KMS_MAX_ATTEMPTS = 2` (original + 1), jitter 50–250ms
  (configurable within those ends), and deadline-aware skip per §4.3 —
  emits `llm_retries_skipped_deadline_total` when a retry would land
  past the span deadline.
- `src/crypto/envelope.ts`: `EnvelopeCrypto` façade with `wrap` /
  `unwrap` / `invalidateUserKey` / `sweepExpired`. DEK cache keyed by
  `(userId, kekVersion)` per §2 invariant 8, TTL hard-capped at 300 s
  (constructor refuses higher). On every `unwrap`, stale cache entries
  for the same `userId` but a different `kekVersion` are zeroised +
  evicted + counted as `llm_dek_cache_stale_hits_total{reason=version_mismatch}`.
- `src/observability/metrics.ts`: narrow `Metrics` interface with
  `NOOP_METRICS` and `InMemoryMetrics` (test helper). Derives
  `llm_kms_retry_success_ratio` from `llm_kms_retries_total{outcome}`
  per §10.2 operational notes — natural to include alongside the
  rest of the crypto metric set (Jean, 2026-04-18).
- `src/types.ts`: shared `Result<T, E>` with `ok` / `err` constructors.
- Public surface: new subpath exports `@chisu/llm-client/crypto` and
  `@chisu/llm-client/observability` (plus re-exports from the root).
- New devDependencies: `aws-sdk-client-mock`, `fast-check`. New
  dependency: `@aws-sdk/client-kms`.

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
