/**
 * Public surface of `@chisu/llm-client`.
 *
 * Iteration 1 scope: error taxonomy + classifiers + flag config.
 * Iteration 2 scope: envelope encryption (KEK-per-shard, DEK cache
 *   TTL ≤300s, zeroisation).
 * Iteration 3 scope: provider adapters — Anthropic Messages,
 *   OpenAI Chat Completions, Gemini AI Studio — behind a narrow
 *   `Provider` interface + an injectable `HttpClient` abstraction.
 * Iteration 4 scope: plan-aware router + per-provider circuit
 *   breaker. Implements LLM_CLIENT.md §4 (routing matrix + CB state
 *   machine). BYOK required for Free/Creator; Influencer+ with
 *   `preferMyKey` falls back Managed-ward on any per-key transient
 *   (`invalid_key` | `quota_exhausted` | `rate_limit` |
 *   `network_error`, Ajuste 6 FULL). CB transitions emit to `Metrics`
 *   + `onStateChange`.
 * Iteration 5 scope: audit sink for CB state transitions.
 *   `createCircuitAuditSink(deps)` returns an `OnCircuitStateChange`
 *   that turns §11 two auditable transitions
 *   (`llm.circuit_opened`, `llm.circuit_closed`) into
 *   `SystemAuditEntry` **drafts** and delegates persistence to an
 *   injected `AuditWriter`. `open→half-open` and `half-open→open`
 *   are NOT auditable per §11 — they increment
 *   `llm_audit_ignored_transitions_total{from,to}` instead. The
 *   writer owns the hash chain (id / sequence / prevHash / rowHash);
 *   llm-client stays DB-agnostic.
 * Iteration 6 scope: OTel correlation + deadline propagation.
 * Iteration 7 scope (closed): token accounting + consent modes.
 *   Commit 1 realigned `OriginKind` to contract §3.3 (5 signed values).
 *   Commit 2 introduced the `ConsentResolver` DI seam +
 *   `UserLLMKeyRepo` interface + `llm_consent_mode_resolved_total`
 *   counter.
 *   Commit 3 added the `UsageRecorder` writer seam + in-memory FIFO
 *   `UsageBuffer` (capacity 1000, §8 decisión #2) + full SHA-256-hex
 *   `prompt-hash` canonicaliser (§8 decisión #1) +
 *   `llm.accounting.write` sub-span (§5.3) + 4 accounting metrics
 *   (`llm_accounting_writes_total{consent_mode,funding_mode,result}`,
 *   `llm_accounting_writes_failed_total{reason}`,
 *   `llm_accounting_writes_dropped_total{reason}`,
 *   `llm_accounting_buffer_size`).
 *   Commit 4 wired both seams into `plan-router.route()` per §4.2
 *   billable-vs-pre-call matrix: every `.call()` that touches the
 *   wire emits exactly one `UsageEntry`. Recording fires on provider
 *   success (real tokens) and on billable errors (`rate_limit |
 *   quota_exhausted | provider_down | content_blocked | network_error
 *   | internal`, 0/0 tokens). Pre-call errors (`invalid_key |
 *   context_too_long | kms_unavailable | routing_disabled |
 *   plan_requires_key`), circuit-breaker denies, and router-minted
 *   `internal` rejects DO NOT record — the wire was never touched.
 *   The BYOK→Managed fallback path is two attempts of ONE logical
 *   `.call()`, so it emits up to two rows sharing `traceId +
 *   promptHash + consentMode` (one billable BYOK error + one Managed
 *   success = 2 rows; one `invalid_key` BYOK pre-call + one Managed
 *   success = 1 row). Consent resolves in parallel with the
 *   synchronous registry lookup; resolver is non-throwing by contract
 *   (§8 decisión firmada #8, degrades to `'minimal'`). `latencyMs` is
 *   per-attempt (`performance.now()` around `provider.call`),
 *   intentionally distinct from the root span `llm.latency_ms`
 *   (the `.call()` total). See §4.1 / §4.2 / §5.3 / §8 of
 *   LLM_CLIENT.md v1.1 and `.cmsgs/iter7-accounting-design.md`.
 *
 * Iteration 8 commit 1 shipped the `IdempotencyStore` interface +
 *   in-memory LRU `InMemoryIdempotencyStore` (capacity 10 000, TTL
 *   expiry-on-read, Map-insertion-order LRU) + `buildIdempotencyKey`
 *   helper. No facade wiring yet — iter 8 commit 3 consumes this
 *   surface.
 * Iteration 8 commit 2 shipped the `FlushScheduler` — a standalone
 *   orchestrator around `UsageRecorder.flush()` with three triggers
 *   (`'interval'`, `'threshold'`, `'close'`), serialised flushes,
 *   idempotent `start()` / `stop()`, empty-buffer short-circuit, and
 *   a new `llm_flush_scheduler_runs_total{trigger}` counter. Also
 *   introduced the shared `Logger` surface + `NOOP_LOGGER` default
 *   under `observability/`. The facade (commit 3) owns one scheduler
 *   per `LLMClient` instance and calls `notifyBufferChanged()` after
 *   every successful `.call()`.
 * Iteration 8 commit 3 shipped the `LLMClient` facade itself — the
 *   public entry point that composes the 6 previously-signed internals
 *   (crypto, plan-router, circuit audit, OTel, accounting, idempotency
 *   + flush scheduler). Adds idempotency lookup/set around
 *   `plan-router.route()`, deadline enforcement via
 *   `AbortSignal.any([caller, AbortSignal.timeout(budget)])`, an
 *   in-memory inflight gauge (`llm_client_inflight_calls`), and
 *   graceful `close()` with drain timeout
 *   (`llm_client_close_drained_total{result=drained|timeout}`). The
 *   facade wraps every call in the root `llm.client.call` span that
 *   the plan router reuses (§5.3 iter 8 forward-compat) so
 *   `traceId`/`spanId` stay aligned across retry and fallback attempts.
 *   Delegated decisions firmadas 2026-04-21:
 *     #1 deadline_exceeded → `make.networkError(false)` + span
 *        `setStatus(ERROR, 'deadline_exceeded')`;
 *     #2 closed/invalid_input → `make.internal('client.call: closed')`
 *        / `make.internal('client.call: invalid_input')` with span
 *        attribute `llm.internal_reason='closed'|'invalid_input'`;
 *     #3 LLMCallInput superset → accept `user: UserQuota` + §3.3
 *        fields; `idempotencyKey?` IGNORED (derived from
 *        `(userId, hashNormalizedRequest, model)`); `correlationId`
 *        derived from `traceparent` with `randomUUID()` fallback.
 *   The `LLMCallInput` type is a superset of `NormalizedLLMRequest`
 *   so callers can pass planner output unchanged.
 *
 * Iter 9 commit 1 (pendiente 18.3) promoted `correlationId?: string`
 *   from `.passthrough()`-only into a typed optional field on
 *   `LLMCallInput`. Resolution order in the facade: (1) non-empty
 *   `input.correlationId` caller override wins verbatim,
 *   (2) `deriveCorrelationId(input.traceparent)` parses the 32-char
 *   traceId, (3) fresh `randomUUID()` fallback inside
 *   `deriveCorrelationId`. Local to `@chisu/llm-client` — does NOT
 *   touch `@chisu/schemas` nor require semver bump nor re-firma.
 *   See `docs/LLM_CLIENT.md` §18.3.
 *
 * @see ../../../docs/LLM_CLIENT.md — the signed contract this
 *      package implements (v1.1 SIGNED, 2026-04-18).
 */

export * from './errors/index.js';
export * from './config/index.js';
export * from './crypto/index.js';
export * from './observability/index.js';
export * from './providers/index.js';
export * from './http/index.js';
export * from './routing/index.js';
export * from './accounting/index.js';
export * from './idempotency/index.js';
export * from './scheduler/index.js';
export {
  LLMClient,
  deriveCorrelationId,
  CLIENT_SPAN_NAME,
  INFLIGHT_GAUGE,
  CLOSE_DRAINED_COUNTER,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  DEFAULT_DRAIN_TIMEOUT_MS,
  type LLMClientConfig,
  type LLMClientDeps,
  type LLMCallOptions,
  type LLMCallInput,
  type LLMCallSuccess,
} from './client.js';
export type {
  NormalizedContentBlock,
  NormalizedLLMRequest,
  NormalizedMessage,
  NormalizedTool,
  ModelId,
  ResponseFormat,
  LLMCallOutput,
  ProviderCallOutput,
  PingOutput,
  StopReason,
  UsageCounts,
  ConsentMode,
  UserLLMKeyRepo,
} from './types/index.js';
export { type Result, ok, err } from './types.js';
