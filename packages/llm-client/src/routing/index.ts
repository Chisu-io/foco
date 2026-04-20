/**
 * Public surface of the routing layer — Iteration 4 of the
 * `@chisu/llm-client` implementation plan.
 *
 * Exports the plan-aware router + per-provider circuit breaker that
 * sit between `LLMClient.call()` (iter 7) and the three provider
 * adapters (iter 3). Shapes and identifiers are verbatim with
 * LLM_CLIENT.md §4 + §10.2 + §11.
 */

export {
  type CircuitDecision,
  type CircuitOutcome,
  type CircuitState,
  type CircuitStateChangeEvent,
  type OnCircuitStateChange,
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
