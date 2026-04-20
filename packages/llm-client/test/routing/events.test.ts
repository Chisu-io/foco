/**
 * Targeted coverage for `src/routing/events.ts` exhaustiveness helpers.
 *
 * Closes the coverage gap flagged during iter 4 verification:
 *  - `gaugeValueForState` default branch (line 53).
 *  - `classifyOutcomeForBreaker` default branch (line 125).
 *  - `assertNeverState` / `assertNeverKind` (lines 212–220).
 *
 * These branches are unreachable from correctly-typed call sites. They
 * only fire when TypeScript's exhaustiveness check is bypassed — e.g. a
 * new `CircuitState` variant is added without updating the switch, or
 * a future version of `LLMCallError` lands in the wild. Forcing the
 * invariant to be exercised catches the drift before it ships.
 *
 * The happy-path assertions for these helpers already live in
 * `circuit-breaker.test.ts` (§ gaugeValueForState and §
 * classifyOutcomeForBreaker) — this file is strictly about the
 * defensive branches.
 */

import { describe, expect, it } from 'vitest';

import type { LLMCallError } from '../../src/errors/taxonomy.js';
import {
  classifyOutcomeForBreaker,
  gaugeValueForState,
  type CircuitState,
} from '../../src/routing/index.js';

// ─── gaugeValueForState ───────────────────────────────────────────────

describe('gaugeValueForState — exhaustiveness guard', () => {
  it('throws with a helpful message when given an unknown state', () => {
    // Bypass TS to reach the default branch. Simulates a future
    // CircuitState variant added without updating the switch.
    const sneaky = 'tripped' as unknown as CircuitState;
    expect(() => gaugeValueForState(sneaky)).toThrow(
      /Unhandled CircuitState: "tripped"/,
    );
  });

  it('serialises unknown states with JSON.stringify so structured variants are legible', () => {
    // Belt-and-braces: the helper uses JSON.stringify so an object-shaped
    // state (e.g. a tagged-union variant) would still be readable in the
    // thrown error. Hitting this path is the only way to cover line 53
    // + lines 212–214 at the same time.
    const shaped = { kind: 'unreachable', meta: 42 } as unknown as CircuitState;
    expect(() => gaugeValueForState(shaped)).toThrow(
      /Unhandled CircuitState: \{"kind":"unreachable","meta":42\}/,
    );
  });
});

// ─── classifyOutcomeForBreaker ────────────────────────────────────────

describe('classifyOutcomeForBreaker — exhaustiveness guard', () => {
  it('throws with the error variant serialised when given an unknown kind', () => {
    // Simulates a future LLMCallError variant that lands before the
    // classifier is extended. The switch default must throw rather
    // than silently classify as `neutral` — that would hide a
    // breaker-blind spot.
    const ghost = { kind: 'warp_drive_overload', detail: 'nacelle' } as unknown as LLMCallError;
    expect(() => classifyOutcomeForBreaker(ghost)).toThrow(
      /Unhandled LLMCallError kind in classifyOutcomeForBreaker:/,
    );
    expect(() => classifyOutcomeForBreaker(ghost)).toThrow(
      /"kind":"warp_drive_overload"/,
    );
  });

  it('throws even when the unknown variant has no extra fields', () => {
    const minimal = { kind: 'mystery' } as unknown as LLMCallError;
    expect(() => classifyOutcomeForBreaker(minimal)).toThrow(
      /Unhandled LLMCallError kind in classifyOutcomeForBreaker: \{"kind":"mystery"\}/,
    );
  });
});
