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
