/**
 * Audit sink for circuit-breaker state transitions.
 *
 * Consumes the `OnCircuitStateChange` hook left prepared in Iteration 4
 * and produces `SystemAuditEntry` **drafts** that the hosting service
 * persists to the `system_audit` table (PRODUCTION_READINESS.md §3).
 *
 * ## Scope
 *
 * Iter 5 only. Ships the CB sink — the other six actions in
 * `LLM_CLIENT.md §11` (`llm.key_added`, `llm.key_rotated`,
 * `llm.key_invalidated`, `llm.kek_rotated`, `llm.managed_call_high_spend`,
 * `llm.abuse_suspected`) land in later iterations with their own sink
 * factories, following this template.
 *
 * ## What is (and is NOT) audited
 *
 * `LLM_CLIENT.md §11` lists exactly **two** CB transitions as auditable:
 *
 *   | action                | transition          | body          |
 *   |-----------------------|---------------------|---------------|
 *   | `llm.circuit_opened`  | closed → open       | provider, errorRate, volume |
 *   | `llm.circuit_closed`  | half-open → closed  | provider |
 *
 * The other two transitions the breaker can emit (`open → half-open`
 * on cooldown, `half-open → open` on probe failure) are **not**
 * auditable per §11. The sink records them to
 * `llm_audit_ignored_transitions_total{from,to}` as a sanity signal
 * (a dashboard check that the counter advances in lock-step with
 * `llm_circuit_transitions_total`) but does not write them to
 * `system_audit`. Widening §11 requires a signed adjustment to the
 * contract, not an implementation decision.
 *
 * ## Hash chain ownership
 *
 * The sink produces an `AuditEntryDraft` — `SystemAuditEntry` minus
 * `id`, `sequence`, `prevHash`, `rowHash`. Those four fields are
 * global to `system_audit` and are closed by the **writer** inside
 * the DB transaction that holds the tail lock. Serialising
 * `prevHash` from inside the breaker would race with the other six
 * §11 emitters.
 *
 * ## Fail-safe
 *
 * The callback returned by `createCircuitAuditSink` honours the
 * non-throw / non-block contract of `OnCircuitStateChange`
 * (`events.ts:179–184`): it schedules the insert via
 * `queueMicrotask` and returns. Writer failures increment
 * `llm_audit_write_failures_total{action,reason}` and are logged, but
 * never propagate back into the breaker — audit data for CB
 * transitions is diagnostic, not legal. The upcoming sinks for
 * `llm.key_*` will `await` with bounded retry from the handler
 * that originated the mutation (where the transaction is).
 *
 * ## Key safety
 *
 * The sink cannot leak API key plaintext because the
 * `CircuitStateChangeEvent` it receives has no key material — the
 * router resolves keys one layer up. A defensive regex test in
 * `audit-sink.test.ts` scans every produced draft for
 * `sk-ant-.../sk-.../AIza...` patterns and fails if any fixture
 * slips through.
 *
 * @see LLM_CLIENT.md §11 — audit actions table
 * @see LLM_CLIENT.md §14.3 — CI linter regex
 * @see PRODUCTION_READINESS.md §3 — `system_audit` table + hash chain
 * @see events.ts — `CircuitStateChangeEvent` shape
 */

import type {
  SystemActor,
  SystemActorKind,
  SystemAuditEntry,
} from '@chisu/schemas';

import type { Metrics } from '../observability/metrics.js';
import type { Result } from '../types.js';
import type {
  CircuitStateChangeEvent,
  OnCircuitStateChange,
} from './events.js';

// ─── Types ───────────────────────────────────────────────────────────

/**
 * Re-export the canonical actor types from `@chisu/schemas` so
 * consumers of `@chisu/llm-client` who only care about the audit sink
 * surface don't need a direct workspace import on `@chisu/schemas`.
 * The names are kept identical to upstream — there is no local alias
 * layer. If a new kind is added in `common.ts::SYSTEM_ACTOR_KINDS`
 * upstream, the compiler here flags the drift before a draft can
 * ship with an invalid `actor.kind`.
 */
export type { SystemActor, SystemActorKind };

/**
 * Draft row produced by the sink. Literal
 * `Omit<SystemAuditEntry, 'id' | 'sequence' | 'prevHash' | 'rowHash'>`
 * from `@chisu/schemas` — those four fields are closed by the writer
 * inside the DB transaction that holds the `system_audit` tail lock
 * per `PRODUCTION_READINESS.md §3`. Keeping the draft tied to the
 * signed schema (not a local duplicate) turns any upstream addition
 * of a kind or field into a compile-time error here rather than a
 * runtime validation failure at the hosting boundary.
 *
 * For the CB sink specifically, the sink always emits `resource` and
 * `details` as present objects (the `buildDetails` helper below
 * constructs them unconditionally); the schema itself allows those
 * fields to be `null | undefined` because other sinks (e.g.
 * `llm.kek_rotated`) may legitimately omit them.
 */
export type AuditEntryDraft = Omit<
  SystemAuditEntry,
  'id' | 'sequence' | 'prevHash' | 'rowHash'
>;

/**
 * Error taxonomy the writer returns. Kept narrow and non-PII. The
 * `message` field SHOULD NOT contain user data — the sink's logger
 * does not forward it to the structured log.
 */
export type AuditWriteError =
  | { readonly kind: 'transport'; readonly message: string }
  | { readonly kind: 'constraint_violation'; readonly message: string }
  | { readonly kind: 'serialization'; readonly message: string }
  | { readonly kind: 'internal'; readonly message: string };

/**
 * DI seam for the writer — mirrors `HttpClient` in iter 3 and the
 * `KMSClient` dependency in iter 2. Hosting app builds the adapter
 * (pg / drizzle / supabase-js) and injects it.
 */
export interface AuditWriter {
  insert(draft: AuditEntryDraft): Promise<Result<void, AuditWriteError>>;
}

/**
 * Minimal logger signature. Optional — the sink falls back to
 * counter-only reporting if unset. The logger MUST NOT throw;
 * exceptions here are caught and reported as `internal` on the
 * failures counter.
 */
export type AuditSinkLogger = (
  msg: string,
  ctx: Readonly<Record<string, unknown>>,
) => void;

export interface AuditSinkDeps {
  readonly writer: AuditWriter;
  readonly metrics: Metrics;
  /** Clock for `occurredAt`. Defaults to `Date.now`. */
  readonly now?: () => number;
  readonly logger?: AuditSinkLogger;
  /**
   * Actor attributed to CB-originated entries. Defaults to
   * `{ kind: 'system' }` — these transitions are not user-triggered.
   */
  readonly actor?: SystemActor;
}

// ─── Metric names (additive to §10.2) ────────────────────────────────

/**
 * Sink-specific counters. Additive to the §10.2 metric surface —
 * they instrument the sink itself, not the breaker or router. Prefix
 * `llm_audit_` mirrors the `llm_` namespace used throughout.
 */
export const AUDIT_SINK_METRIC_NAMES = {
  /**
   * `{action, reason}` — counted once per failed insert. `reason`
   * is one of `AuditWriteError['kind']` or `'internal'` (logger or
   * unexpected rejection).
   */
  writeFailures: 'llm_audit_write_failures_total',
  /**
   * `{from, to}` — counted once per non-auditable CB transition
   * (`open→half-open`, `half-open→open`). Used as a dashboard sanity
   * check against `llm_circuit_transitions_total`.
   */
  ignoredTransitions: 'llm_audit_ignored_transitions_total',
} as const;

// ─── Pure helpers ────────────────────────────────────────────────────

/**
 * Map a `(from, to)` pair to its signed §11 action name, or
 * `undefined` if the transition is not auditable per the contract.
 * Pure function — no side effects.
 */
export function auditActionForTransition(
  from: CircuitStateChangeEvent['from'],
  to: CircuitStateChangeEvent['to'],
): 'llm.circuit_opened' | 'llm.circuit_closed' | undefined {
  if (from === 'closed' && to === 'open') return 'llm.circuit_opened';
  if (from === 'half-open' && to === 'closed') return 'llm.circuit_closed';
  return undefined;
}

/**
 * Build the `details` body for a transition. Shape matches §11:
 *  - opened: `{ errorRate, volume, reason }` — errorRate and volume
 *    are always present in `closed → open` events (see
 *    `circuit-breaker.ts`); still, we only include them if defined
 *    so the payload stays `Record<string, string | number>` (no
 *    nullables).
 *  - closed: `{ reason }`
 */
function buildDetails(
  action: 'llm.circuit_opened' | 'llm.circuit_closed',
  event: CircuitStateChangeEvent,
): Readonly<Record<string, string | number>> {
  if (action === 'llm.circuit_opened') {
    const base: Record<string, string | number> = { reason: event.reason };
    if (event.errorRate !== undefined) base['errorRate'] = event.errorRate;
    if (event.volume !== undefined) base['volume'] = event.volume;
    return base;
  }
  // half-open → closed
  return { reason: event.reason };
}

/**
 * Build the full draft from an event + deps. Extracted so tests can
 * exercise the mapping independently from the async write path.
 */
export function buildAuditDraft(
  event: CircuitStateChangeEvent,
  action: 'llm.circuit_opened' | 'llm.circuit_closed',
  deps: AuditSinkDeps,
): AuditEntryDraft {
  const nowFn = deps.now ?? Date.now;
  // The event carries the transition timestamp (`event.at`). Prefer
  // that — it's the authoritative moment the transition happened. We
  // still accept `deps.now` so tests can pin the clock even when the
  // event's `at` isn't stable.
  const at = event.at ?? nowFn();
  const actor: SystemActor = deps.actor ?? { kind: 'system' };
  const draft: AuditEntryDraft = {
    occurredAt: new Date(at).toISOString(),
    actor,
    action,
    resource: { type: 'llm_provider', id: event.provider },
    details: buildDetails(action, event),
  };
  return draft;
}

// ─── Factory ─────────────────────────────────────────────────────────

/**
 * Construct the audit sink callback.
 *
 * The returned function:
 *
 *  1. Maps `(from, to)` to the §11 action — if `undefined`, bumps
 *     `llm_audit_ignored_transitions_total{from,to}` and returns.
 *  2. Builds the `AuditEntryDraft` synchronously.
 *  3. Schedules `writer.insert(draft)` via `queueMicrotask` — the
 *     breaker does not block on audit I/O.
 *  4. On insert failure (whether `err(...)` or a bare rejection),
 *     bumps `llm_audit_write_failures_total{action, reason}` and
 *     calls the optional logger. Never rethrows.
 *
 * All steps are protected by a top-level try/catch so that even a
 * bug in `buildAuditDraft` or the metrics sink cannot surface as a
 * thrown exception back to the breaker — the `OnCircuitStateChange`
 * contract (`events.ts:179–184`) requires non-throwing.
 */
export function createCircuitAuditSink(
  deps: AuditSinkDeps,
): OnCircuitStateChange {
  return (event: CircuitStateChangeEvent): void => {
    try {
      const action = auditActionForTransition(event.from, event.to);
      if (action === undefined) {
        deps.metrics.counter(AUDIT_SINK_METRIC_NAMES.ignoredTransitions, {
          from: event.from,
          to: event.to,
        });
        return;
      }
      const draft = buildAuditDraft(event, action, deps);
      // Fire-and-forget. The breaker continues; audit is diagnostic.
      queueMicrotask(() => {
        writeAndReport(draft, action, deps);
      });
    } catch (unexpected) {
      // Defensive: a bug upstream (metrics sink, clock, etc.)
      // must not propagate into the breaker. Count it, try to log,
      // and swallow.
      safeBumpFailure(deps, 'unknown', 'internal');
      safeLog(deps, 'audit_sink_unexpected_error', {
        error: describeError(unexpected),
      });
    }
  };
}

// ─── Internal helpers ────────────────────────────────────────────────

function writeAndReport(
  draft: AuditEntryDraft,
  action: 'llm.circuit_opened' | 'llm.circuit_closed',
  deps: AuditSinkDeps,
): void {
  // Guard the `.then/.catch` chain so a synchronous throw from the
  // writer (a buggy adapter that rejects the Promise by throwing
  // before returning it) still lands on the failures counter.
  let promise: Promise<Result<void, AuditWriteError>>;
  try {
    promise = deps.writer.insert(draft);
  } catch (sync) {
    safeBumpFailure(deps, action, 'internal');
    safeLog(deps, 'audit_write_unexpected', {
      action,
      error: describeError(sync),
    });
    return;
  }
  promise.then(
    (res) => {
      if (res.ok) return;
      safeBumpFailure(deps, action, res.error.kind);
      safeLog(deps, 'audit_write_failed', {
        action,
        reason: res.error.kind,
      });
    },
    (rejection) => {
      // The writer promise rejected (non-Result rejection).
      safeBumpFailure(deps, action, 'internal');
      safeLog(deps, 'audit_write_unexpected', {
        action,
        error: describeError(rejection),
      });
    },
  );
}

function safeBumpFailure(
  deps: AuditSinkDeps,
  action: string,
  reason: AuditWriteError['kind'] | 'internal',
): void {
  try {
    deps.metrics.counter(AUDIT_SINK_METRIC_NAMES.writeFailures, {
      action,
      reason,
    });
  } catch {
    // Swallow — metrics MUST NOT propagate into the breaker.
  }
}

function safeLog(
  deps: AuditSinkDeps,
  msg: string,
  ctx: Readonly<Record<string, unknown>>,
): void {
  if (deps.logger === undefined) return;
  try {
    deps.logger(msg, ctx);
  } catch {
    // Swallow — logger bugs are not the breaker's problem.
  }
}

function describeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
