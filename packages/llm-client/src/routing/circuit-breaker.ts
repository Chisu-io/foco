/**
 * Per-provider circuit breaker.
 *
 * Implements the state machine of
 * {@link ../../../../docs/LLM_CLIENT.md `LLM_CLIENT.md` §4.2 + §11}:
 *
 *  - Sliding-window samples of provider outcomes.
 *  - Transitions `closed → open → half-open → closed|open`.
 *  - Lazy cooldown resolution — no `setTimeout`. Timekeeping is
 *    clock-driven via an injected `now()` so tests are hermetic.
 *  - Emits `llm_circuit_state{provider}` (§10.2) on every transition
 *    and `llm_circuit_outcomes_total{provider,outcome}` counter on
 *    every record.
 *  - Invokes `onStateChange` for every transition. Iteration 6
 *    composes metrics + audit + pino behind that single callback; §11
 *    requires `llm.circuit_opened` and `llm.circuit_closed` to be
 *    audited, the other two transitions are metrics-only.
 *
 * Concurrency model: Node is single-threaded, so all state mutations
 * are atomic within an event-loop tick. We do **not** lock or queue;
 * two interleaved `record()` calls land in well-defined order because
 * the runtime serialises them.
 */

import type { FlagsReader } from '../config/flag-reader.js';
import type { Metrics } from '../observability/metrics.js';
import type { ProviderName } from '../providers/provider.js';
import {
  type CircuitDecision,
  type CircuitOutcome,
  type CircuitState,
  type CircuitStateChangeEvent,
  type OnCircuitStateChange,
  gaugeValueForState,
} from './events.js';

/** One sample in the sliding window. */
interface WindowSample {
  readonly at: number;
  readonly outcome: CircuitOutcome;
}

/** Per-provider state held inside the breaker. */
interface ProviderCbState {
  state: CircuitState;
  /** FIFO, oldest first. Pruned lazily on every read/record. */
  window: WindowSample[];
  /**
   * Wall-clock ms when we entered `open`. Used to evaluate
   * `open → half-open` cooldown lazily.
   */
  openedAt?: number;
  /**
   * How many probes have been handed out by `isCallAllowed()` but
   * not yet `record()`-ed. Capped at `half_open_probes`.
   */
  probesInFlight: number;
  /**
   * How many probes have succeeded since entering half-open. Reset
   * on any transition.
   */
  probesSucceeded: number;
}

/** Dependencies of `createCircuitBreaker`. */
export interface CircuitBreakerDeps {
  readonly flags: FlagsReader;
  readonly metrics: Metrics;
  /**
   * Hook invoked on every transition. Iter 6 wires this to the audit
   * sink + pino. Calls are synchronous — implementations must NOT
   * throw; uncaught exceptions propagate up through `record()` /
   * `isCallAllowed()` which would violate the breaker's invariant
   * of "never throws".
   */
  readonly onStateChange?: OnCircuitStateChange | undefined;
  /**
   * Clock override. Defaults to `Date.now`. Tests inject a stub so
   * the sliding window and cooldown are deterministic.
   */
  readonly now?: (() => number) | undefined;
}

/**
 * Public surface consumed by the router.
 *
 * All methods are synchronous, side-effect-safe, and never throw.
 */
export interface CircuitBreaker {
  /** Ask whether a call to `provider` is allowed right now. */
  isCallAllowed(provider: ProviderName): CircuitDecision;

  /** Record the outcome of a completed call. */
  record(provider: ProviderName, outcome: CircuitOutcome): void;

  /** Current state — useful for logs / tests. */
  currentState(provider: ProviderName): CircuitState;
}

/**
 * Metric names emitted by the breaker. Exported so the audit-sink
 * wiring in Iter 6 can label-match exactly on them without re-declaring
 * the strings.
 */
export const CB_METRIC_NAMES = Object.freeze({
  state: 'llm_circuit_state',
  outcomes: 'llm_circuit_outcomes_total',
  decisions: 'llm_circuit_decisions_total',
  transitions: 'llm_circuit_transitions_total',
});

function emptyState(): ProviderCbState {
  return {
    state: 'closed',
    window: [],
    probesInFlight: 0,
    probesSucceeded: 0,
  };
}

export function createCircuitBreaker(
  deps: CircuitBreakerDeps,
): CircuitBreaker {
  const { flags, metrics, onStateChange } = deps;
  const now = deps.now ?? ((): number => Date.now());
  const states = new Map<ProviderName, ProviderCbState>();

  function stateFor(provider: ProviderName): ProviderCbState {
    let s = states.get(provider);
    if (s === undefined) {
      s = emptyState();
      states.set(provider, s);
      // Seed the gauge so Prometheus doesn't report a gap before the
      // first transition.
      metrics.gauge(
        CB_METRIC_NAMES.state,
        gaugeValueForState(s.state),
        { provider },
      );
    }
    return s;
  }

  function pruneWindow(s: ProviderCbState, nowMs: number): void {
    const windowSec = flags.get('llm.circuit_breaker.window_seconds');
    const cutoff = nowMs - windowSec * 1_000;
    // Window is FIFO so we can shift from the front until the oldest
    // entry is within the cutoff. Loop upper-bounds at window length.
    while (s.window.length > 0 && s.window[0]!.at < cutoff) {
      s.window.shift();
    }
  }

  /** Compute `{failures, successes, neutrals}` from the current window. */
  function tally(s: ProviderCbState): {
    failures: number;
    successes: number;
    neutrals: number;
  } {
    let failures = 0;
    let successes = 0;
    let neutrals = 0;
    for (const e of s.window) {
      if (e.outcome === 'failure') failures++;
      else if (e.outcome === 'success') successes++;
      else neutrals++;
    }
    return { failures, successes, neutrals };
  }

  function transition(
    s: ProviderCbState,
    provider: ProviderName,
    to: CircuitState,
    nowMs: number,
    reason: CircuitStateChangeEvent['reason'],
    extras: { errorRate?: number; volume?: number } = {},
  ): void {
    const from = s.state;
    if (from === to) return;

    s.state = to;

    // Reset bookkeeping tied to the previous / next state.
    if (to === 'open') {
      s.openedAt = nowMs;
      s.probesInFlight = 0;
      s.probesSucceeded = 0;
    } else if (to === 'half-open') {
      s.probesInFlight = 0;
      s.probesSucceeded = 0;
    } else {
      // to === 'closed'
      delete s.openedAt;
      s.probesInFlight = 0;
      s.probesSucceeded = 0;
      // Reset the window on recovery so we don't carry old failures
      // into the post-recovery volume check.
      s.window.length = 0;
    }

    metrics.gauge(
      CB_METRIC_NAMES.state,
      gaugeValueForState(to),
      { provider },
    );
    metrics.counter(CB_METRIC_NAMES.transitions, {
      provider,
      from,
      to,
      reason,
    });

    if (onStateChange !== undefined) {
      const event: CircuitStateChangeEvent = {
        provider,
        from,
        to,
        at: nowMs,
        reason,
        // `exactOptionalPropertyTypes` forbids `{ errorRate: undefined }`.
        ...(extras.errorRate !== undefined
          ? { errorRate: extras.errorRate }
          : {}),
        ...(extras.volume !== undefined ? { volume: extras.volume } : {}),
      };
      onStateChange(event);
    }
  }

  /**
   * Lazily advance `open → half-open` if the cooldown has elapsed.
   * Called at the top of `isCallAllowed` and `record`.
   */
  function maybeOpenToHalfOpen(
    s: ProviderCbState,
    provider: ProviderName,
    nowMs: number,
  ): void {
    if (s.state !== 'open') return;
    const cooldownSec = flags.get(
      'llm.circuit_breaker.open_cooldown_seconds',
    );
    const openedAt = s.openedAt ?? nowMs;
    if (nowMs - openedAt >= cooldownSec * 1_000) {
      transition(s, provider, 'half-open', nowMs, 'cooldown_elapsed');
    }
  }

  function isCallAllowed(provider: ProviderName): CircuitDecision {
    const nowMs = now();
    const s = stateFor(provider);
    maybeOpenToHalfOpen(s, provider, nowMs);

    let decision: CircuitDecision;
    if (s.state === 'closed') {
      decision = 'allow';
    } else if (s.state === 'open') {
      decision = 'deny_open';
    } else {
      // half-open — hand out a probe slot if budget remains.
      const probeBudget = flags.get(
        'llm.circuit_breaker.half_open_probes',
      );
      if (s.probesInFlight < probeBudget) {
        s.probesInFlight++;
        decision = 'probe';
      } else {
        decision = 'deny_probes_exhausted';
      }
    }

    metrics.counter(CB_METRIC_NAMES.decisions, { provider, decision });
    return decision;
  }

  function record(
    provider: ProviderName,
    outcome: CircuitOutcome,
  ): void {
    const nowMs = now();
    const s = stateFor(provider);
    maybeOpenToHalfOpen(s, provider, nowMs);

    s.window.push({ at: nowMs, outcome });
    pruneWindow(s, nowMs);

    metrics.counter(CB_METRIC_NAMES.outcomes, { provider, outcome });

    if (s.state === 'closed') {
      // Evaluate the threshold. Volume counts only failures +
      // successes; neutrals are observational and do not count toward
      // either the threshold or the volume gate (see events.ts).
      const { failures, successes } = tally(s);
      const volume = failures + successes;
      const volumeThreshold = flags.get(
        'llm.circuit_breaker.volume_threshold',
      );
      if (volume < volumeThreshold) return;

      const errorThreshold = flags.get(
        'llm.circuit_breaker.error_threshold',
      );
      const errorRate = volume === 0 ? 0 : failures / volume;
      if (errorRate > errorThreshold) {
        transition(s, provider, 'open', nowMs, 'error_rate_exceeded', {
          errorRate,
          volume,
        });
      }
      return;
    }

    if (s.state === 'half-open') {
      // Release the reservation. `record` callers must have been
      // given a `probe` decision beforehand, but we clamp to 0 so an
      // out-of-order record() doesn't underflow.
      if (s.probesInFlight > 0) s.probesInFlight--;

      if (outcome === 'failure') {
        transition(s, provider, 'open', nowMs, 'probe_failed');
        return;
      }
      if (outcome === 'success') {
        s.probesSucceeded++;
        const probeBudget = flags.get(
          'llm.circuit_breaker.half_open_probes',
        );
        if (s.probesSucceeded >= probeBudget) {
          transition(s, provider, 'closed', nowMs, 'probes_succeeded');
        }
        return;
      }
      // outcome === 'neutral' — don't count toward success, stay put.
      return;
    }

    // state === 'open' after maybeOpenToHalfOpen. A record() landing
    // here is a sign that the caller bypassed `isCallAllowed`, but
    // we still capture the sample for observability. No state change.
  }

  function currentState(provider: ProviderName): CircuitState {
    const nowMs = now();
    const s = stateFor(provider);
    maybeOpenToHalfOpen(s, provider, nowMs);
    return s.state;
  }

  return Object.freeze({ isCallAllowed, record, currentState });
}
