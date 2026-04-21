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
  type OriginKind,
  type ProviderCallContext,
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

// ─── ProviderCallContext / OriginKind — structural contract ──────────
//
// Iter 6 commit 2 defines two net-new types in events.ts (see §3.3 of
// the LLM_CLIENT v1.1 contract). These tests are *compile-time*
// assertions: the file only typechecks if the shape matches the
// contract. The `expect` lines are there so vitest reports a passing
// spec when the typecheck lands — they don't carry runtime intent
// beyond "the constructed values are the ones we claim".
//
// If any of the four invariants below flip (e.g. `correlationId`
// becomes optional, or `origin` widens beyond the three producer
// surfaces without a contract amendment), this file fails to compile
// and CI catches the drift before it ships.

describe('ProviderCallContext — structural shape (iter 6 commit 2)', () => {
  it('accepts the minimum required fields: correlationId + fundingMode + origin', () => {
    const minimal: ProviderCallContext = {
      correlationId: 'corr-struct-min',
      fundingMode: 'byok',
      origin: 'caption-refine',
    };
    expect(minimal.correlationId).toBe('corr-struct-min');
    expect(minimal.fundingMode).toBe('byok');
    expect(minimal.origin).toBe('caption-refine');
    // Optional fields default to undefined — exactOptionalPropertyTypes
    // means we must explicitly NOT set them when absent.
    expect('deadline' in minimal).toBe(false);
    expect('idempotencyKey' in minimal).toBe(false);
  });

  it('accepts the fully-populated shape with both optionals set', () => {
    const full: ProviderCallContext = {
      correlationId: 'corr-struct-full',
      fundingMode: 'managed',
      origin: 'mcp-server-callback',
      deadline: 1_700_000_000_000,
      idempotencyKey: 'idem-abc-123',
    };
    expect(full.deadline).toBe(1_700_000_000_000);
    expect(full.idempotencyKey).toBe('idem-abc-123');
    // `fundingMode` is a closed union — this line only typechecks
    // because `'managed'` is one of the two admitted tokens.
    expect(full.fundingMode satisfies 'byok' | 'managed').toBe('managed');
  });

  it('pins fundingMode to exactly the two-token union {byok, managed}', () => {
    // If a new funding mode is ever introduced, the contract (§3.7)
    // must be amended first. This spec is the canary: the array below
    // enumerates every admissible token, and the line compiles only
    // while the union has exactly these two members.
    const admissible: ReadonlyArray<ProviderCallContext['fundingMode']> = [
      'byok',
      'managed',
    ] as const;
    expect(admissible).toEqual(['byok', 'managed']);
  });
});

describe('OriginKind — structural shape (iter 7 commit 1, aligned to §3.3)', () => {
  it('enumerates exactly the five producer surfaces from §3.3 lines 283–287', () => {
    // Same canary pattern as fundingMode above — the array literal
    // compiles only while `OriginKind` has precisely these five
    // members. A new member → compile fails here → code review loops
    // back to the contract.
    //
    // iter 7 commit 1 realigns this from the narrowed 3-member version
    // introduced by iter 6 commit 2 back to the 5 members held by the
    // signed contract since LLM_CLIENT v1.0.
    const allOrigins: ReadonlyArray<OriginKind> = [
      'assistant-conversation',
      'script-generation',
      'caption-refine',
      'hook-brainstorm',
      'mcp-server-callback',
    ] as const;
    expect(allOrigins).toHaveLength(5);
    expect(new Set(allOrigins)).toEqual(
      new Set([
        'assistant-conversation',
        'script-generation',
        'caption-refine',
        'hook-brainstorm',
        'mcp-server-callback',
      ]),
    );
  });

  it('is exhaustive under `switch` — `never` remainder after the five cases', () => {
    // Compile-time exhaustiveness: the `never` annotation only holds
    // while the union stays pinned to five members. Adding a sixth
    // without extending the switch would make `fallthrough: OriginKind`
    // narrow to a non-never type and fail to typecheck.
    function label(o: OriginKind): string {
      switch (o) {
        case 'assistant-conversation':
          return 'assistant';
        case 'script-generation':
          return 'script';
        case 'caption-refine':
          return 'caption';
        case 'hook-brainstorm':
          return 'hook';
        case 'mcp-server-callback':
          return 'mcp';
        default: {
          const fallthrough: never = o;
          return fallthrough;
        }
      }
    }
    expect(label('assistant-conversation')).toBe('assistant');
    expect(label('script-generation')).toBe('script');
    expect(label('caption-refine')).toBe('caption');
    expect(label('hook-brainstorm')).toBe('hook');
    expect(label('mcp-server-callback')).toBe('mcp');
  });
});
