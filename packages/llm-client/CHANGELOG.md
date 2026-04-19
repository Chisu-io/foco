# Changelog

All notable changes to `@chisu/llm-client` will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — Iteration 3 (provider adapters)

- `src/types/request.ts`: `ModelId` union (7 MVP model ids across the
  three providers), `NormalizedLLMRequest` / `NormalizedMessage` /
  `NormalizedContentBlock` / `NormalizedTool` / `ResponseFormat` — the
  wire-format-agnostic shape the router hands to a provider. Role
  `'tool'` is represented as a first-class discriminant so the OpenAI
  and Gemini adapters can fold it into their provider-specific layout
  without string-matching.
- `src/types/response.ts`: `ProviderCallOutput` / `PingOutput` /
  `LLMCallOutput` / `UsageCounts` / `StopReason`. Deliberately excludes
  `fundingMode` and `latencyMs` — those are the router's job per
  LLM_CLIENT.md §9.4.
- `src/http/client.ts`: narrow `HttpClient` abstraction
  (`(HttpRequest) => Promise<HttpResponse>`) + `HttpTransportError`
  discriminated class. `fetchHttpClient` is the default implementation,
  walks the `cause` chain up to 5 hops mapping undici / node error
  codes (`ETIMEDOUT`, `UND_ERR_CONNECT_TIMEOUT`, `ECONNREFUSED`,
  `EAI_AGAIN`, `ENOTFOUND`, `ECONNRESET`, TLS …) to a kind enum. DI
  seam keeps `msw` and `undici.MockAgent` out of the provider test
  harness entirely.
- `src/providers/provider.ts`: `Provider` interface (`call` + `ping`
  returning `Result<ProviderCallOutput|PingOutput, LLMCallError>`),
  four documented invariants (never throws, no key material in
  errors, no I/O side-effects beyond HTTP, body buffering).
- `src/providers/anthropic.ts`: `createAnthropicProvider` factory.
  Targets `POST https://api.anthropic.com/v1/messages` with
  `x-api-key` + `anthropic-version: 2023-06-01`. Translates
  `system`/`user`/`assistant`/`tool` messages to Anthropic's
  `messages` + `system` fields, tool_use ↔ tool_result blocks,
  `input_tokens`/`output_tokens` → `UsageCounts`, `stop_reason`
  enum → `StopReason`. HTTP 529 (overloaded) collapsed to 503 per
  §7.1. `ping` uses Haiku + `max_tokens: 1` to keep the probe cheap.
- `src/providers/openai.ts`: `createOpenAIProvider` factory. Targets
  `POST https://api.openai.com/v1/chat/completions` with
  `Authorization: Bearer`. `systemPrompt` is prepended as a `system`
  message (OpenAI has no separate field). Tool calls are emitted as
  assistant `tool_calls[]` with JSON-stringified `arguments`;
  provider-side JSON-decoded back into `NormalizedContentBlock.input`
  on the inbound path. Rate-limit headers (`x-ratelimit-remaining-*`,
  `x-ratelimit-reset-*`) parsed — including compound durations like
  `"1m30s"` — into `rateLimitHints`. **`finish_reason: content_filter`
  short-circuits to `err(make.contentBlocked('policy'))`** — it is an
  error, not a successful completion. `insufficient_quota` error code
  on HTTP 429 is promoted to `quota_exhausted{billingError: true}`
  per the §7.1 billing short-circuit.
- `src/providers/gemini.ts`: `createGeminiProvider` factory. Targets
  `POST {base}/{model}:generateContent` with **`x-goog-api-key`
  header — never `?key=` query param** (§2 invariant 1 — no key
  material in URL). Role translation: `assistant` → `'model'`,
  `tool` → `'user'` with a `functionResponse` part.
  `systemInstruction` is a separate top-level field (Gemini does not
  accept a system role inside `contents[]`). `tools` wraps all
  definitions in a single `functionDeclarations` container.
  `FinishReason: SAFETY | RECITATION` and `promptFeedback.blockReason`
  short-circuit to `err(make.contentBlocked('safety'))`. HTTP 400
  with body containing `"API key not valid"` → `invalid_key` (Google
  uses 400 where others use 401). 403 / 429 with a billing keyword
  (`billing` / `quota project` / `free tier` / `daily limit`) is
  classified as `quota_exhausted{billingError: true}`; otherwise 403
  → `invalid_key` and 429 plain → `rate_limit`. `functionCall` parts
  synthesise a `toolUseId` of `${name}-${ordinal}` (Gemini has no
  first-class tool_use id) and promote `STOP` → `'tool_use'` when
  present.
- `src/providers/index.ts`: barrel re-exporting the three factories,
  their `*Deps` types, the endpoint / model / timeout constants, and
  the `Provider` / `ProviderCallInput` / `ProviderPingInput` types.
  `ProviderName` is intentionally **not** re-exported here — it stays
  canonical at `./errors` per §9.4 to avoid an `export *` collision
  at the package root.
- Public surface: new subpath exports `@chisu/llm-client/http`,
  `@chisu/llm-client/providers`, `@chisu/llm-client/types` — and the
  matching entries in `publishConfig.exports` for when the package
  publishes its built `dist/`.
- `test/providers/_fake-http.ts`: `fakeHttp(resolver)`,
  `throwTransport(kind)`, `jsonResponse(status, body, headers?)`,
  and `neverTimeout` — the minimal test harness for all three
  adapters. No real timers, no real sockets, no MSW.
- `test/providers/anthropic.test.ts`: ~350 lines covering outbound
  wire format (endpoint, headers, role translation, `input_schema`
  propagation, no key in URL), inbound parsing (text + usage +
  `providerRequestId`, tool_use blocks, stop_reason mapping,
  malformed JSON → `provider_down`), and §7.1 error mapping for
  401/402/429 (with `retry-after`)/500/502/503/504/**529 collapsed
  to 503**/400+context/400+policy, plus transport timeout / DNS
  failure, and a `ping` success.
- `test/providers/openai.test.ts`: ~370 lines covering Bearer auth,
  system-prompt prepending, sampling params, tool fan-out,
  `tool_call_id` messages, `finish_reason: length → max_tokens`,
  `tool_calls` JSON-decoded to `NormalizedContentBlock.input`,
  **`finish_reason: content_filter` → `content_blocked` error (not
  success)**, 401 / 402 / 429 plain / 429 + `insufficient_quota`
  (billing short-circuit) / 400 + `context_length_exceeded` / 400 +
  `content_filter` / 500 / TCP transport, and ping with rate-limit
  hints (`remainingRequests: 99`, `remainingTokens: 1234`,
  `resetSec: 90` parsed from `"1m30s"`).
- `test/providers/gemini.test.ts`: ~400 lines covering
  `{base}/{model}:generateContent` URL composition,
  `x-goog-api-key` header with **explicit `expect(url).not.toContain
  ('key=')` assertion**, separate `systemInstruction`,
  `generationConfig` nesting, `assistant → 'model'` and
  `tool → functionResponse` role translation, `functionDeclarations`
  wrapping, `candidates` / `usageMetadata` / `modelVersion` parsing,
  `MAX_TOKENS`, `functionCall` → `tool_use` with stop `'tool_use'`,
  `SAFETY` / `RECITATION` / `promptFeedback.blockReason` →
  `content_blocked{safety}`, **HTTP 400 + `"API key not valid"` →
  `invalid_key`**, 401 `UNAUTHENTICATED` → `invalid_key`, 403 +
  billing → `quota_exhausted`, 403 plain → `invalid_key`, 429 +
  billing → `quota_exhausted`, 429 plain → `rate_limit{retryAfterSec:30}`,
  400 + context, 500/502/503/504, TLS transport, and ping.

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
- **No new runtime dependency in Iteration 3.** Providers use
  `globalThis.fetch` (Node ≥24 ships undici's fetch). The
  `HttpClient` DI seam keeps `msw` / `undici.MockAgent` out of the
  test harness — the three provider test files (`anthropic.test.ts`,
  `openai.test.ts`, `gemini.test.ts`) use a ~40-line `_fake-http.ts`
  helper instead.
