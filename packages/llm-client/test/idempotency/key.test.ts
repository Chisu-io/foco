/**
 * Tests for {@link buildIdempotencyKey}.
 *
 * Contract encoded (iter 8 prompt, "idempotency.key" decision):
 *
 *  1. Output shape: 64-char lowercase hex digest (SHA-256 full).
 *  2. Deterministic: same tuple → same digest across calls.
 *  3. Order-sensitive across positional arguments (userId vs
 *     promptHash vs model cannot be swapped without changing the
 *     digest).
 *  4. A swap between any two fields of identical length produces a
 *     different digest (defensive: ensures the separator actually
 *     participates in the pre-image).
 *  5. The canonical pre-image is exactly
 *     `${userId}:${promptHash}:${model}` — reproducing the digest
 *     by hand with `node:crypto` matches.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  IDEMPOTENCY_KEY_SEPARATOR,
  buildIdempotencyKey,
} from '../../src/idempotency/key.js';

const USER = 'user-42';
// A realistic 64-char hex SHA-256 digest (stand-in for a real
// `hashNormalizedRequest` output). Any hex string of the right shape
// works — the key builder does not re-validate.
const PROMPT_HASH =
  'a'.repeat(64); // 64 lowercase 'a's → valid hex
const MODEL = 'claude-3-5-sonnet-20241022';

describe('buildIdempotencyKey — shape', () => {
  it('returns a 64-char lowercase hex digest', () => {
    const key = buildIdempotencyKey(USER, PROMPT_HASH, MODEL);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('separator constant is the literal colon', () => {
    expect(IDEMPOTENCY_KEY_SEPARATOR).toBe(':');
  });
});

describe('buildIdempotencyKey — determinism and sensitivity', () => {
  it('is deterministic across calls', () => {
    const a = buildIdempotencyKey(USER, PROMPT_HASH, MODEL);
    const b = buildIdempotencyKey(USER, PROMPT_HASH, MODEL);
    expect(a).toBe(b);
  });

  it('different userId → different key', () => {
    const a = buildIdempotencyKey('user-1', PROMPT_HASH, MODEL);
    const b = buildIdempotencyKey('user-2', PROMPT_HASH, MODEL);
    expect(a).not.toBe(b);
  });

  it('different promptHash → different key', () => {
    const a = buildIdempotencyKey(USER, 'a'.repeat(64), MODEL);
    const b = buildIdempotencyKey(USER, 'b'.repeat(64), MODEL);
    expect(a).not.toBe(b);
  });

  it('different model → different key', () => {
    const a = buildIdempotencyKey(USER, PROMPT_HASH, 'claude-3-haiku');
    const b = buildIdempotencyKey(USER, PROMPT_HASH, 'claude-3-opus');
    expect(a).not.toBe(b);
  });

  it('swapping userId with model of the same length changes the key', () => {
    // Defensive: if the builder ever concatenated without a separator,
    // `buildIdempotencyKey('abc', H, 'xyz')` and
    // `buildIdempotencyKey('xyz', H, 'abc')` could collide. With the
    // colon separator they cannot, because the separator-bearing
    // pre-image differs.
    const a = buildIdempotencyKey('abc', PROMPT_HASH, 'xyz');
    const b = buildIdempotencyKey('xyz', PROMPT_HASH, 'abc');
    expect(a).not.toBe(b);
  });
});

describe('buildIdempotencyKey — canonical pre-image', () => {
  it('matches a hand-computed SHA-256 over "userId:promptHash:model"', () => {
    const expected = createHash('sha256')
      .update(`${USER}:${PROMPT_HASH}:${MODEL}`, 'utf8')
      .digest('hex');
    expect(buildIdempotencyKey(USER, PROMPT_HASH, MODEL)).toBe(expected);
  });

  it('uses the exported separator constant in the pre-image', () => {
    const sep = IDEMPOTENCY_KEY_SEPARATOR;
    const expected = createHash('sha256')
      .update(`${USER}${sep}${PROMPT_HASH}${sep}${MODEL}`, 'utf8')
      .digest('hex');
    expect(buildIdempotencyKey(USER, PROMPT_HASH, MODEL)).toBe(expected);
  });
});
