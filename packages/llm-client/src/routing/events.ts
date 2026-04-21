/**
 * Routing-layer events and breaker-outcome classification.
 *
 * Types-only module: no runtime logic beyond pure helpers
 * (`gaugeValueForState`, `classifyOutcomeForBreaker`). Kept separate
 * from `circuit-breaker.ts` so that `plan-router.ts` can depend on the
 * event shapes without pulling in the breaker's state machine.
 *
 * Contract references:
 *  - §4.2 "Circuit breaker por proveedor" — states, sliding window,
 *    cooldown, half-open probes.
 *  - §10.2 "Observability" — `llm_circuit_state{provider}` gauge
 *    values (0 / 1 / 2).
 *  - §11 "Audit" — the two **auditable** transitions:
 *    `llm.circuit_opened` and `llm.circuit_closed`. The other two
 *    internal transitions (open→half-open, half-open→open) emit only
 *    to metrics; the audit sink lands in Iteration 6.
 *  - §3.5 / §9.4 — never-throws invariant: every classifier here is
 *    total and side-effect free.
 */

import type { LLMCallError } from '../errors/taxonomy.js';
import type { ProviderName } from '../providers/provider.js';

/**
 * Canonical state of a per-provider circuit breaker.
 *
 * Matches the three labels used in the signed contract (§4.2) and the
 * gauge values exposed in §10.2.
 */
export type CircuitState = 'closed' | 'half-open' | 'open';

/**
 * Gauge value used by `llm_circuit_state{provider}` (§10.2).
 *
 * Kept as a monotone encoding so a dashboard can assert
 * `max(llm_circuit_state) > 1` to trigger a "provider is shedding
 * load" alert without having to string-match on labels.
 *
 * @returns `0` closed · `1` half-open · `2` open
 */
export function gaugeValueForState(state: CircuitState): 0 | 1 | 2 {
  switch (state) {
    case 'closed':
      return 0;
    case 'half-open':
      return 1;
    case 'open':
      return 2;
    default:
      // Exhaustiveness guard — `state: never` when the switch is
      // total. Keeps typecheck honest if a state is ever added.
      return assertNeverState(state);
  }
}

/**
 * Outcome dimension the breaker records on every observed call.
 *
 *  - `success` — provider returned `ok`.
 *  - `failure` — provider returned an error that is attributable to
 *    *its* infrastructure (`provider_down`, `network_error`, `rate_limit`,
 *    `internal`). These count toward the error rate that can trip
 *    the breaker.
 *  - `neutral` — error not attributable to the provider
 *    (`invalid_key`, `content_blocked`, `context_too_long`,
 *    `plan_requires_key`, `routing_disabled`, `kms_unavailable`,
 *    `quota_exhausted`). These are recorded in metrics but do NOT
 *    count toward the sliding-window error rate. Tripping the
 *    breaker on, say, a customer's invalid API key would punish the
 *    provider for a user mistake.
 *
 * The router may override the classifier's output before calling
 * `breaker.record(...)` — that's the seam Iteration 7 uses to flag a
 * Managed-pool `quota_exhausted` as `failure` (pool rotation signal)
 * while keeping it `neutral` for BYOK.
 */
export type CircuitOutcome = 'success' | 'failure' | 'neutral';

/**
 * Classify an `LLMCallError` into a breaker outcome.
 *
 * Total function over `LLMCallError['kind']`. Does NOT accept the
 * success case — the caller passes `'success'` explicitly when the
 * provider returned `ok`, which keeps this signature sharp and makes
 * the switch exhaustive for TypeScript.
 *
 * **Iter 4 policy (Free/Creator):**
 *  - `quota_exhausted` → `neutral`. A BYOK user running out of their
 *    own credit is not a provider health signal.
 *
 * **Iter 7 policy note (Managed pool):**
 *  When the Managed shared pool is added, the router should treat a
 *  `quota_exhausted` from the pool as `failure` so the breaker helps
 *  rotate away from an exhausted pool key. That override is the
 *  router's job (see the callback seam in `plan-router.ts`), NOT this
 *  classifier's — so the classifier stays a single source of truth
 *  for the "is this error the provider's fault?" question.
 *
 * @see LLM_CLIENT.md §3.5 — full taxonomy
 * @see LLM_CLIENT.md §7.1 — "detección y mapeo desde proveedores"
 */
export function classifyOutcomeForBreaker(
  error: LLMCallError,
): Exclude<CircuitOutcome, 'success'> {
  switch (error.kind) {
    // Provider infrastructure signals — count toward the breaker.
    case 'provider_down':
    case 'network_error':
    case 'rate_limit':
    case 'internal':
      return 'failure';

    // User / environment / policy — do not punish the provider.
    case 'invalid_key':
    case 'quota_exhausted': // iter 4 policy — see JSDoc above
    case 'content_blocked':
    case 'context_too_long':
    case 'kms_unavailable':
    case 'routing_disabled':
    case 'plan_requires_key':
      return 'neutral';

    default:
      return assertNeverKind(error);
  }
}

/**
 * Structured event emitted on every circuit-breaker state transition.
 *
 * The breaker raises four kinds of transitions:
 *
 *  1. `closed → open`      — error rate exceeded threshold, volume met.
 *  2. `open → half-open`   — cooldown elapsed (lazy; resolved on next
 *                            `isCallAllowed()` / `record(...)`).
 *  3. `half-open → closed` — all half-open probes succeeded.
 *  4. `half-open → open`   — a half-open probe failed.
 *
 * **Only (1) and (3) are auditable** per §11 — they map to
 * `llm.circuit_opened` / `llm.circuit_closed`. The other two go only
 * to metrics. The event shape carries enough context that a single
 * sink can route on `(from, to)`; the audit wiring lands in Iter 6.
 */
export interface CircuitStateChangeEvent {
  readonly provider: ProviderName;
  readonly from: CircuitState;
  readonly to: CircuitState;
  readonly at: number;
  /**
   * Error rate (0–1) observed in the sliding window that caused the
   * transition. Populated for `closed → open` (the audit expects it
   * per §11). Omitted otherwise.
   */
  readonly errorRate?: number | undefined;
  /**
   * Total request count observed in the sliding window at the
   * transition point. Populated for `closed → open`. Omitted
   * otherwise.
   */
  readonly volume?: number | undefined;
  /**
   * Short opaque reason tag — useful for logs and for the audit sink
   * in Iter 6 without leaking provider response shapes.
   */
  readonly reason:
    | 'error_rate_exceeded'
    | 'cooldown_elapsed'
    | 'probes_succeeded'
    | 'probe_failed';
}

/**
 * Callback signature the breaker invokes on every transition. The
 * router wires this up; Iteration 6 composes metrics + audit + pino
 * behind a single function.
 *
 * Must be synchronous and non-throwing — the breaker does NOT
 * swallow exceptions from this callback (it would hide bugs in the
 * instrumentation layer). Implementations that need async work
 * (e.g. insert a row in `audit_log`) should schedule it via
 * `queueMicrotask` or their own worker and return.
 */
export type OnCircuitStateChange = (event: CircuitStateChangeEvent) => void;

/**
 * Decision returned by `CircuitBreaker.isCallAllowed()`. Narrow enum
 * so the router's branching is exhaustive.
 *
 *  - `allow`       — breaker is `closed`.
 *  - `probe`       — breaker is `half-open` and the probe budget
 *                    has capacity. The router treats this like
 *                    `allow` but the breaker has already reserved a
 *                    probe slot.
 *  - `deny_open`   — breaker is `open`; cooldown has not elapsed.
 *  - `deny_probes_exhausted` — half-open but the probe budget is
 *                    full. The router should treat it like `open`
 *                    (fail-fast with `provider_down{circuitOpen:true}`).
 */
export type CircuitDecision =
  | 'allow'
  | 'probe'
  | 'deny_open'
  | 'deny_probes_exhausted';

// ─── Request origin + routing-layer call context ────────────────────
//
// Both types are net-new in iter 6 commit 2. They formalise the
// "who is calling, with what trace identity, and under what deadline"
// context that flows from `LLMClient.call()` (iter 7) down through the
// plan router and into each provider adapter.
//
// §3.3 of the signed contract lists the public `LLMCallInput.origin`
// values — see lines 285–287. The union here stays verbatim with that
// list; widening it forces a contract re-signature per the three-
// contracts rule.

/**
 * Known producer surfaces that invoke `LLMClient.call()`.
 *
 *  - `caption-refine`       — Foco caption polish pass (UX_FROZEN §2.4).
 *  - `hook-brainstorm`      — opening-hook generation (UX_FROZEN §2.3).
 *  - `mcp-server-callback`  — inbound MCP bi-directional tool callback
 *                             (§3.6 of the MCP subproject).
 *
 * Extending the union requires a contract amendment (§3.3). A call
 * site that cannot legitimately claim one of these origins has no
 * business calling `LLMClient.call()` — the routing layer cannot
 * attribute cost, audit, or rate-limit against an unknown origin.
 *
 * @see LLM_CLIENT.md §3.3 — `LLMCallInput.origin`
 */
export type OriginKind =
  | 'caption-refine'
  | 'hook-brainstorm'
  | 'mcp-server-callback';

/**
 * Routing-layer context threaded from `LLMClient.call()` through the
 * plan router and into each provider adapter.
 *
 * This is the **routing-internal** shape. Adapters receive a tighter
 * slice of it (`ProviderCallInput` in `../providers/provider.ts`) —
 * specifically, only `correlationId` crosses the adapter boundary.
 * `fundingMode` is a routing concern (the adapter does not know
 * whether the key came from BYOK or the Managed pool), `origin` is a
 * caller-facing attribution label, and `deadline` + `idempotencyKey`
 * are plumbing the router owns.
 *
 * Commit 2 (this commit) only **defines** the shape so downstream
 * iterations can thread it:
 *
 *  - Commit 3 consumes it in the router's root span + provider sub-span
 *    (span attributes include `funding_mode`, `origin`, hashed
 *    `idempotency_key`).
 *  - Commit 5 consumes `deadline` to compute the per-call timeout
 *    budget + forward it as `AbortSignal.timeout(remaining)`.
 *
 * Invariants:
 *  1. `correlationId` is the SAME identity used for:
 *     - `LLMCallError.internal.correlationId` when the router mints
 *       an `internal` error (no more ad-hoc `newCorrelationId()` per
 *       call site).
 *     - the OTel root span (`Trace.setSpan`, iter 6 commit 3).
 *     - outbound provider trace headers (`anthropic-trace-id`,
 *       `X-Request-ID` — commit 2 wires these).
 *  2. `idempotencyKey`, if set, MUST NOT leak into logs or span
 *     attributes raw. Adapters/tracers MUST hash via
 *     `hashIdempotencyKey()` (iter 6 commit 1).
 *  3. `deadline` is a Unix epoch in milliseconds, NOT a duration.
 *     A missing deadline means "no external deadline"; each adapter
 *     still enforces its own per-call timeout.
 */
export interface ProviderCallContext {
  /** Trace / correlation ID — flows into spans, logs, and trace headers. */
  readonly correlationId: string;
  /**
   * Absolute deadline as a Unix epoch millisecond timestamp, NOT a
   * duration. Commit 5 converts this into a remaining-budget
   * `AbortSignal.timeout(...)`.
   */
  readonly deadline?: number | undefined;
  /**
   * Caller-supplied idempotency key. Echoed into telemetry as a
   * **hashed** label (never raw) per `hashIdempotencyKey` in
   * `../observability/tracing.ts` (iter 6 commit 1).
   */
  readonly idempotencyKey?: string | undefined;
  /**
   * Funding mode resolved by the router. Analytics/audit only — the
   * adapter does not receive this because a correctly-written adapter
   * treats BYOK and Managed keys identically.
   */
  readonly fundingMode: 'byok' | 'managed';
  /** Producer surface that invoked `LLMClient.call()`. See {@link OriginKind}. */
  readonly origin: OriginKind;
}

// ─── Exhaustiveness helpers ───────────────────────────────────────────
//
// `assertNever` in `errors/taxonomy.ts` is a *throwing* helper used in
// contexts where we already have a correlation ID. Here we want pure
// functions that return `never` so the switch is a total mapping.

function assertNeverState(x: never): never {
  throw new Error(`Unhandled CircuitState: ${JSON.stringify(x)}`);
}

function assertNeverKind(x: never): never {
  throw new Error(
    `Unhandled LLMCallError kind in classifyOutcomeForBreaker: ${JSON.stringify(x)}`,
  );
}
