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
 *   that turns §11's two auditable transitions
 *   (`llm.circuit_opened`, `llm.circuit_closed`) into
 *   `SystemAuditEntry` **drafts** and delegates persistence to an
 *   injected `AuditWriter`. `open→half-open` and `half-open→open`
 *   are NOT auditable per §11 — they increment
 *   `llm_audit_ignored_transitions_total{from,to}` instead. The
 *   writer owns the hash chain (id / sequence / prevHash / rowHash);
 *   llm-client stays DB-agnostic.
 * Iteration 6 scope: OTel correlation + deadline propagation.
 * Iteration 7 scope (in progress): token accounting + consent modes.
 *   Commit 1 realigned `OriginKind` to contract §3.3 (5 signed values).
 *   Commit 2 introduced the `ConsentResolver` DI seam +
 *   `UserLLMKeyRepo` interface + `llm_consent_mode_resolved_total`
 *   counter.
 *   Commit 3 (this) adds the `UsageRecorder` writer seam + in-memory
 *   FIFO `UsageBuffer` (capacity 1000, §8 decisión #2) + full
 *   SHA-256-hex `prompt-hash` canonicaliser (§8 decisión #1) +
 *   `llm.accounting.write` sub-span (§5.3) + 4 new metrics
 *   (`llm_accounting_writes_total{consent_mode,funding_mode,result}`,
 *   `llm_accounting_writes_failed_total{reason}`,
 *   `llm_accounting_writes_dropped_total{reason}`,
 *   `llm_accounting_buffer_size`). No router wiring yet — that
 *   lands in commit 4 which plumbs both seams into
 *   `plan-router.route()` per §4.2's billable-vs-pre-call matrix.
 *   See §8 of LLM_CLIENT.md v1.1 and
 *   `.cmsgs/iter7-accounting-design.md`.
 *
 * The `LLMClient.call()` surface (orchestrator, latency, idempotency)
 * lands in Iteration 8 of the implementation plan.
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
