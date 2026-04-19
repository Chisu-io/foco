# @chisu/llm-client

Plan-aware LLM client for Foco. Implements
[`docs/LLM_CLIENT.md` v1.1](../../docs/LLM_CLIENT.md) — the fourth
anchor contract of Foco.

## Status

Iteration 3 of 9 (see `project_foco_llm_client_implementation_plan`).
**Not production-ready yet.** Iteration 1 shipped the error taxonomy
and flag config layer; Iteration 2 shipped the envelope-encryption
crypto layer (KEK-per-shard, DEK cache TTL ≤300 s, zeroisation);
Iteration 3 (this) ships the three MVP provider adapters — Anthropic
Messages, OpenAI Chat Completions, and Gemini AI Studio — behind a
narrow `Provider` interface and an injectable `HttpClient` abstraction.
The plan-aware `LLMClient.call()` surface (BYOK vs Managed routing,
circuit breakers, token accounting) lands in Iteration 7.

## Scope

`@chisu/llm-client` is the single entrypoint for any **generative LLM
call** in Foco. It decides in runtime whether the call routes through
the user's own API key (BYOK — Free / Creator plans) or Foco's
managed pool (Influencer / Celebrity / Studio plans).

Not in scope (use dedicated clients):

- Embeddings (`@chisu/embedding-client`)
- Content moderation (CSAM, NSFW, deepfake)
- ASR (Whisper in Modal)
- TTS / voice cloning

See the contract's §1 for the full boundary.

## Public surface (current)

```ts
import {
  // Error taxonomy (§3.5)
  LLMCallError,
  LLMErrorCode,
  // Classifiers (§7.1)
  classifyProviderHttpError,
  classifyKmsError,
  classifyNetworkError,
  // Flag config (§16)
  FLAG_DEFAULTS,
  validateFlags,
  loadFlagsWithFallback,
  FlagValidationError,
  // Crypto layer (§5)
  EnvelopeCrypto,
  MAX_DEK_CACHE_TTL_MS,
  shardId,
  shardCountFor,
  kekAlias,
  generateDek,
  zeroize,
  // Observability
  NOOP_METRICS,
  InMemoryMetrics,
  // Provider adapters (§9) — new in Iter 3
  createAnthropicProvider,
  createOpenAIProvider,
  createGeminiProvider,
  type Provider,
  type ProviderCallInput,
  type ProviderPingInput,
  // HTTP client DI seam
  fetchHttpClient,
  type HttpClient,
  HttpTransportError,
  // Normalised wire-format types
  type NormalizedLLMRequest,
  type NormalizedMessage,
  type NormalizedContentBlock,
  type NormalizedTool,
  type ModelId,
  type ResponseFormat,
  type LLMCallOutput,
  type ProviderCallOutput,
  type PingOutput,
  type StopReason,
  type UsageCounts,
  // Shared result
  ok,
  err,
} from '@chisu/llm-client';
```

The `LLMClient.call()` surface lands in Iteration 7.

## Invariants this package enforces

See the contract's §2 for the full list. Highlights relevant to the
current surface:

1. **Zero plaintext of user API keys** in logs, traces, audit bodies,
   errors or span attributes — **and never in a request URL**. Gemini
   uses the `x-goog-api-key` header (not the supported `?key=` query
   param) specifically to keep keys out of server access logs. A CI
   linter lands in Iteration 8.
2. **Fail-closed with a hard-capped retry budget.** `classifyKmsError`
   returns `{ transient: true }` only for 5xx/throttle; otherwise
   `{ transient: false }` → caller must not retry.
3. **Flag hard-caps.** `validateFlags` treats `llm.kms.retry_count ≤ 1`
   and `llm.dek_cache.ttl_seconds ≤ 300` as invariants of the doc,
   **not** runtime-adjustable. Raising them requires a PR to
   `LLM_CLIENT.md`, not a GrowthBook toggle.
4. **No circuit breaker over KMS.** `kek.ts` retries at most once
   (`KMS_MAX_ATTEMPTS = 2`) with 50–250 ms jitter; on transient
   failure after the retry budget, or on non-transient error, we
   fail-close. A CB over KMS would only add latency (§2 invariant 5).
5. **Cache key = `(userId, kekVersion)`.** Stale entries from a past
   rotation are zeroised and evicted on the next `unwrap`, counted as
   `llm_dek_cache_stale_hits_total{reason=version_mismatch}` (§2
   invariant 8).
6. **Provider adapters never throw and never log.** They return
   `Result<ProviderCallOutput|PingOutput, LLMCallError>` and leave
   metrics / traces / audit to the router. Their only I/O is the
   single HTTP call. `content_filter` / `SAFETY` / `RECITATION` are
   errors (`content_blocked`), not successful completions (§9.4).

## Development

```bash
pnpm --filter @chisu/llm-client typecheck
pnpm --filter @chisu/llm-client test
pnpm --filter @chisu/llm-client build
```

## License

Proprietary — see [`LICENSE-PROPRIETARY`](../../LICENSE-PROPRIETARY).
