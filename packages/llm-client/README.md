# @chisu/llm-client

Plan-aware LLM client for Foco. Implements
[`docs/LLM_CLIENT.md` v1.1](../../docs/LLM_CLIENT.md) — the fourth
anchor contract of Foco.

## Status

Iteration 5 of 9 (see `project_foco_llm_client_implementation_plan`).
**Not production-ready yet.** Iteration 1 shipped the error taxonomy
and flag config layer; Iteration 2 shipped the envelope-encryption
crypto layer (KEK-per-shard, DEK cache TTL ≤300 s, zeroisation);
Iteration 3 shipped the three MVP provider adapters — Anthropic
Messages, OpenAI Chat Completions, and Gemini AI Studio — behind a
narrow `Provider` interface and an injectable `HttpClient` abstraction;
Iteration 4 shipped the **plan-aware router + per-provider circuit
breaker** that sit between `LLMClient.call()` and the three adapters
(BYOK-mandatory for Free / Creator, Managed primary with optional
BYOK fallback for Influencer+ with `preferMyKey=true`, Managed for
Studio; fallback triggers `invalid_key` | `quota_exhausted` |
`rate_limit` | `network_error` per Ajuste 6 FULL, 2026-04-19).
Iteration 5 (this) ships the **audit sink** for CB state transitions:
`createCircuitAuditSink(deps)` returns an `OnCircuitStateChange` that
turns LLM_CLIENT.md §11's two auditable transitions
(`llm.circuit_opened` on closed→open and `llm.circuit_closed` on
half-open→closed) into `SystemAuditEntry` drafts and delegates
persistence to an injected `AuditWriter`. The other two transitions
(`open→half-open`, `half-open→open`) are NOT auditable per §11 — they
increment `llm_audit_ignored_transitions_total{from,to}` instead. The
writer owns the hash chain (id / sequence / prevHash / rowHash) per
PRODUCTION_READINESS.md §3; `llm-client` stays DB-agnostic.
The orchestrator-level `LLMClient.call()` surface (latency
measurement, idempotency, token accounting) lands in Iteration 7.

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
  // Tracing — new in Iter 6 (LLM_CLIENT.md §10.1)
  withSpan,
  hashUserId,
  hashIdempotencyKey,
  setTracer,
  resetTracer,
  SpanKind,
  SpanStatusCode,
  type Span,
  type Tracer,
  type SpanAttrs,
  type WithSpanOptions,
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
  // Routing layer (§4) — new in Iter 4
  createCircuitBreaker,
  createPlanRouter,
  providerForModel,
  routingMismatchUserMessage,
  classifyOutcomeForBreaker,
  gaugeValueForState,
  createStaticFlagsReader,
  CB_METRIC_NAMES,
  ROUTER_METRIC_NAMES,
  type CircuitBreaker,
  type CircuitBreakerDeps,
  type CircuitState,
  type CircuitOutcome,
  type CircuitDecision,
  type CircuitStateChangeEvent,
  type OnCircuitStateChange,
  type PlanRouter,
  type PlanRouterDeps,
  type Plan,
  type BYOKStatus,
  type UserQuota,
  type ResolvedKey,
  type ApiKeyRequest,
  type ApiKeyResolver,
  type ProviderRegistry,
  type RouteInput,
  type RouterCallOutput,
  type FlagsReader,
  // Audit sink (§11) — new in Iter 5
  createCircuitAuditSink,
  buildAuditDraft,
  auditActionForTransition,
  AUDIT_SINK_METRIC_NAMES,
  type AuditEntryDraft,
  type AuditSinkDeps,
  type AuditSinkLogger,
  type AuditWriter,
  type AuditWriteError,
  // Re-exported from @chisu/schemas for consumer convenience
  type SystemActor,
  type SystemActorKind,
  // Shared result
  ok,
  err,
} from '@chisu/llm-client';
```

## Composition — wiring the audit sink to the breaker

The audit sink is a pure consumer of the `OnCircuitStateChange` hook
exposed by `createCircuitBreaker`. The hosting app plugs its own
`AuditWriter` implementation (pg / drizzle / supabase-js — it owns the
`system_audit` tail lock and closes `id` / `sequence` / `prevHash` /
`rowHash`) and hands the callback to the breaker factory:

```ts
import {
  createCircuitBreaker,
  createCircuitAuditSink,
  InMemoryMetrics,
  type AuditWriter,
} from '@chisu/llm-client';

declare const writer: AuditWriter; // built by the hosting app
const metrics = new InMemoryMetrics();

const onStateChange = createCircuitAuditSink({
  writer,
  metrics,
  // Optional overrides:
  // now: () => Date.now(),
  // logger: (msg, ctx) => logger.warn(msg, ctx),
  // actor: { kind: 'system' },
});

const breaker = createCircuitBreaker({
  metrics,
  flags,                 // FlagsReader — §16 CB flags
  onStateChange,
  // now: () => Date.now(),
});
```

The sink **never throws** back into the breaker — it schedules the
insert with `queueMicrotask` and reports failures via
`llm_audit_write_failures_total{action, reason}`. Non-auditable
transitions (`open→half-open`, `half-open→open`) increment
`llm_audit_ignored_transitions_total{from, to}` and are not persisted
per LLM_CLIENT.md §11.

The orchestrator-level `LLMClient.call()` surface (latency,
idempotency, token accounting) lands in Iteration 7.

## Observability — tracing (Iter 6 commit 1, partial)

Tracing infrastructure landed in iter 6 commit 1 ahead of the actual
emission sites (commits 3 and 4). The runtime surface is:

```ts
import {
  withSpan,
  hashUserId,
  hashIdempotencyKey,
  setTracer,
  resetTracer,
  SpanKind,
} from '@chisu/llm-client';

await withSpan(
  'llm.client.call',
  {
    'llm.provider': 'anthropic',
    'llm.funding_mode': 'byok',
    'llm.origin': 'caption-refine',
    'user.id_hash': hashUserId(userId),
  },
  async (span) => {
    const result = await doTheCall();
    span.setAttribute('llm.input_tokens', result.usage.inputTokens);
    span.setAttribute('llm.output_tokens', result.usage.outputTokens);
    return result;
  },
  { kind: SpanKind.CLIENT },
);
```

Invariants:

1. **Single point of span creation.** Every span emitted by this
   package is created through `withSpan(...)`. Importing
   `tracer.startSpan` from `@opentelemetry/api` outside
   `src/observability/tracing.ts` is forbidden — a CI grep lands in
   iter 8 alongside the §14.3 redaction linter. This is how the
   "Prohibido: `llm.api_key`, `llm.key_ciphertext`, contenido de
   prompts/responses" rule of LLM_CLIENT.md §10.1 stays enforceable.
2. **`@opentelemetry/api` is no-op without an SDK.** Production
   hosting apps register a `BasicTracerProvider` (or any other) via
   `provider.register()`. Without registration the tracer is a no-op
   and `withSpan` costs only the `try/finally` overhead. The package
   adds no global side effect on import.
3. **Tests inject their own tracer.** `setTracer(provider.getTracer(...))`
   lets a spec wire a `BasicTracerProvider` bound to an
   `InMemorySpanExporter`; `resetTracer()` in `afterEach` keeps specs
   hermetic.
4. **`hashUserId` is sha256(userId) plain.** No salt — the hash is a
   correlation key, not a long-term storage primitive. Cross-service
   unlinkability is out of scope for iter 6; if it becomes a
   requirement, it is a signed adjustment to §10.1.
5. **Span attribute values are scalar-only.** `SpanAttrs` narrows to
   `string | number | boolean`; OTel allows arrays but every attribute
   in §10.1 is a scalar, so widening would be a footgun.

The actual span emission (`llm.client.call` root,
`llm.provider.request` HTTP sub-span, `llm.kms.decrypt_dek` BYOK
sub-span) lands in iter 6 commits 3 and 4. The `llm.accounting.write`
sub-span ships with iter 7 token accounting. Cross-process baggage
propagation is deferred per §8 of the iter 6 mini-spec.

### Facade `correlationId` policy (iter 8 upcoming)

Internal APIs introduced in iter 6 commits 2+ require
`correlationId: string` (non-optional). The public facade in iter 8
implements the borderline policy: in `NODE_ENV === 'production'`,
omitting `correlationId` raises `ValidationError` immediately with no
retry or fallback (line 295 of LLM_CLIENT.md — "obligatorio en
producción"); in development, the facade auto-generates a UUID v4 and
emits a `corrId_autogenerated` log event. Iter 6 documents this;
implementation lands in iter 8.

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
7. **Plan-aware routing never throws and never falls back silently.**
   Free / Creator require BYOK — no Managed fallback. Influencer+
   with `preferMyKey=true` falls back to Managed on any per-key
   transient: `invalid_key` | `quota_exhausted` | `rate_limit` |
   `network_error` (Ajuste 6 FULL, 2026-04-19). `provider_down` is
   NOT a fallback trigger — the §4.2 circuit breaker already covers
   provider-wide outages upstream, so auto-fallback there would be
   redundant. `kms_unavailable` / resolver failures are surfaced
   because Managed uses the same KMS. The `onByokKeyInvalidated`
   hook fires ONLY on `invalid_key` — the other fallback triggers
   leave the key row untouched (§4.1, §6).
8. **No `setTimeout` in the circuit breaker.** State transitions are
   clock-driven via an injected `now()`; cooldowns are resolved
   lazily at the top of every `isCallAllowed()` / `record()` call.
   This keeps the breaker deterministic in tests and avoids timer
   drift in production.
9. **Audit sink is non-blocking and non-throwing.** The callback
   returned by `createCircuitAuditSink` honours the sync / non-throw
   contract of `OnCircuitStateChange` (`events.ts:179–184`). It
   schedules the insert with `queueMicrotask` and catches every
   failure path (writer throws synchronously, writer returns
   `err(...)`, writer rejects the promise with a non-Result value,
   the optional `logger` throws, the `metrics.counter` call throws)
   without rethrowing — CB audit is diagnostic, not legal. The
   `llm.key_*` sinks that land in later iterations will `await` with
   bounded retry from the handler that originated the mutation.
10. **Audit draft carries no key material.** The sink only receives
    a `CircuitStateChangeEvent` — keys are resolved one layer up in
    `plan-router.ts` and never cross the CB boundary. A test in
    `audit-sink.test.ts` scans every produced draft against the
    §14.3 linter regex (`sk-ant-…` / `sk-…` / `AIza…`) and fails if
    any pattern slips through.
11. **Hash chain stays with the writer; draft shape is
    compile-time-coupled to the signed schema.**
    `AuditEntryDraft` is declared as `Omit<SystemAuditEntry, 'id' |
    'sequence' | 'prevHash' | 'rowHash'>` where `SystemAuditEntry`
    is imported (type-only) from `@chisu/schemas`. Those four
    fields are closed inside the DB transaction that holds the
    `system_audit` tail lock per PRODUCTION_READINESS.md §3 —
    serialising `prevHash` from inside the breaker would race with
    the other six §11 emitters. Binding the draft type to the
    signed schema turns any upstream addition of a kind or field
    into a compile-time error here rather than a runtime
    validation failure at the hosting boundary.
12. **Only §11 transitions are persisted.** `llm.circuit_opened`
    (closed → open) and `llm.circuit_closed` (half-open → closed)
    are the two auditable CB actions per LLM_CLIENT.md §11. The
    other two transitions (`open → half-open`, `half-open → open`)
    are **not** auditable — they increment
    `llm_audit_ignored_transitions_total{from, to}` as a sanity
    signal against `llm_circuit_transitions_total`. Widening §11
    requires a signed adjustment to the contract, not an
    implementation decision.

## Development

```bash
pnpm --filter @chisu/llm-client typecheck
pnpm --filter @chisu/llm-client test
pnpm --filter @chisu/llm-client build
```

## License

Proprietary — see [`LICENSE-PROPRIETARY`](../../LICENSE-PROPRIETARY).
