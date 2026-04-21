/**
 * Public surface of the routing layer.
 *
 * Iter 4 shipped the plan-aware router + per-provider circuit breaker
 * that sit between `LLMClient.call()` (iter 7) and the three provider
 * adapters (iter 3). Shapes and identifiers are verbatim with
 * LLM_CLIENT.md §4 + §10.2 + §11.
 *
 * Iter 5 adds the **audit sink** — a composable
 * `OnCircuitStateChange` callback that turns the two auditable CB
 * transitions from §11 (`llm.circuit_opened`, `llm.circuit_closed`)
 * into `SystemAuditEntry` drafts and delegates persistence to an
 * injected `AuditWriter`. The other two transitions
 * (`open→half-open`, `half-open→open`) are intentionally **not**
 * audited per §11 — they increment
 * `llm_audit_ignored_transitions_total{from,to}` instead.
 */

export {
  type CircuitDecision,
  type CircuitOutcome,
  type CircuitState,
  type CircuitStateChangeEvent,
  type OnCircuitStateChange,
  type OriginKind,
  type ProviderCallContext,
  classifyOutcomeForBreaker,
  gaugeValueForState,
} from './events.js';

export {
  type CircuitBreaker,
  type CircuitBreakerDeps,
  CB_METRIC_NAMES,
  createCircuitBreaker,
} from './circuit-breaker.js';

export {
  type ApiKeyRequest,
  type ApiKeyResolver,
  type BYOKStatus,
  type Plan,
  type PlanRouter,
  type PlanRouterDeps,
  type ProviderRegistry,
  type ResolvedKey,
  type RouteInput,
  type RouterCallOutput,
  type UserQuota,
  ROUTER_METRIC_NAMES,
  createPlanRouter,
  providerForModel,
  routingMismatchUserMessage,
} from './plan-router.js';

export {
  type AuditEntryDraft,
  type AuditSinkDeps,
  type AuditSinkLogger,
  type AuditWriteError,
  type AuditWriter,
  type SystemActor,
  type SystemActorKind,
  AUDIT_SINK_METRIC_NAMES,
  auditActionForTransition,
  buildAuditDraft,
  createCircuitAuditSink,
} from './audit-sink.js';
