import { describe, expect, it } from 'vitest';

import {
  FLAG_DEFAULTS,
  FLAG_FALLBACK_ENV_VAR,
  FlagValidationError,
  LLM_FLAGS,
  LLM_FLAG_NAMES,
  loadFlagsWithFallback,
  validateFlags,
} from '../../src/config/index.js';

/** Builds a valid input object starting from §16 defaults. */
function valid(overrides: Partial<Record<string, number>> = {}): Record<string, number> {
  return { ...FLAG_DEFAULTS, ...overrides };
}

describe('FLAG_DEFAULTS', () => {
  it('matches every flag name defined in LLM_FLAG_NAMES', () => {
    const defaultKeys = Object.keys(FLAG_DEFAULTS).sort();
    const names = [...LLM_FLAG_NAMES].sort();
    expect(defaultKeys).toEqual(names);
  });

  it('has retry_count ≤ 1 (§16 hard-cap)', () => {
    expect(FLAG_DEFAULTS['llm.kms.retry_count']).toBeLessThanOrEqual(1);
    expect(LLM_FLAGS['llm.kms.retry_count'].max).toBe(1);
    expect(LLM_FLAGS['llm.kms.retry_count'].hardCap).toBe(true);
  });

  it('has dek_cache.ttl_seconds ≤ 300 (§16 hard-cap)', () => {
    expect(FLAG_DEFAULTS['llm.dek_cache.ttl_seconds']).toBeLessThanOrEqual(300);
    expect(LLM_FLAGS['llm.dek_cache.ttl_seconds'].max).toBe(300);
    expect(LLM_FLAGS['llm.dek_cache.ttl_seconds'].hardCap).toBe(true);
  });

  it('is frozen — mutation attempts throw in strict mode', () => {
    expect(() => {
       
      (FLAG_DEFAULTS as any)['llm.kms.retry_count'] = 99;
    }).toThrow();
  });
});

describe('validateFlags', () => {
  it('accepts the §16 defaults verbatim', () => {
    const result = validateFlags(FLAG_DEFAULTS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.values).toEqual(FLAG_DEFAULTS);
    }
  });

  it('rejects missing flags', () => {
    const missing: Record<string, number> = { ...FLAG_DEFAULTS };
    delete missing['llm.kms.retry_count'];

    const result = validateFlags(missing);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(FlagValidationError);
      expect(result.error.issues[0]?.flag).toBe('llm.kms.retry_count');
      expect(result.error.issues[0]?.code).toBe('not_a_finite_number');
    }
  });

  it('rejects non-finite numbers (NaN, Infinity, strings)', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, '50' as unknown as number]) {
      const result = validateFlags(
        valid({ 'llm.kms.retry_jitter_ms_min': bad }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.issues[0]?.code).toBe('not_a_finite_number');
      }
    }
  });

  it('rejects values above min/max (per-flag range)', () => {
    const result = validateFlags(
      valid({ 'llm.circuit_breaker.error_threshold': 0.95 }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]).toMatchObject({
        flag: 'llm.circuit_breaker.error_threshold',
        code: 'out_of_range',
        expected: { min: 0.05, max: 0.9 },
      });
    }
  });

  it('refuses to raise retry_count above 1 (hard-cap)', () => {
    const result = validateFlags(valid({ 'llm.kms.retry_count': 2 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const issue = result.error.issues[0];
      expect(issue?.flag).toBe('llm.kms.retry_count');
      expect(issue?.message).toMatch(/hard-cap/i);
    }
  });

  it('refuses to raise dek_cache.ttl_seconds above 300 (hard-cap)', () => {
    const result = validateFlags(valid({ 'llm.dek_cache.ttl_seconds': 600 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.issues[0]?.flag).toBe('llm.dek_cache.ttl_seconds');
      expect(result.error.issues[0]?.message).toMatch(/hard-cap/i);
    }
  });

  it('catches jitter_min ≥ jitter_max (cross-invariant)', () => {
    const result = validateFlags(
      valid({
        'llm.kms.retry_jitter_ms_min': 300,
        'llm.kms.retry_jitter_ms_max': 300,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const jitter = result.error.issues.find(
        (i) => i.code === 'jitter_order',
      );
      expect(jitter).toBeDefined();
      expect(jitter?.flag).toBe('cross_invariant');
    }
  });

  it('catches open_cooldown > window × 5 (cross-invariant)', () => {
    const result = validateFlags(
      valid({
        'llm.circuit_breaker.open_cooldown_seconds': 300, // legal per-flag
        'llm.circuit_breaker.window_seconds': 10, // 10 × 5 = 50 < 300
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const cross = result.error.issues.find(
        (i) => i.code === 'cooldown_over_window',
      );
      expect(cross).toBeDefined();
    }
  });

  it('accepts open_cooldown exactly at window × 5 (inclusive bound)', () => {
    const result = validateFlags(
      valid({
        'llm.circuit_breaker.open_cooldown_seconds': 50,
        'llm.circuit_breaker.window_seconds': 10,
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('skips cross-invariants when per-flag validation already failed', () => {
    const result = validateFlags(
      valid({ 'llm.kms.retry_jitter_ms_min': Number.NaN }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // We should see the NaN error, but no downstream `jitter_order`
      // confusion — cross-invariants don't fire on partial data.
      expect(result.error.issues.some((i) => i.code === 'jitter_order')).toBe(
        false,
      );
    }
  });

  it('collects multiple issues in one pass', () => {
    const result = validateFlags(
      valid({
        'llm.circuit_breaker.error_threshold': 2,
        'llm.abuse.sustained_hours': 50,
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.issues).toHaveLength(2);
    }
  });

  it('rejects non-object input', () => {
    const result = validateFlags(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Every flag is reported missing.
      expect(result.error.issues.length).toBe(LLM_FLAG_NAMES.length);
    }
  });
});

describe('loadFlagsWithFallback', () => {
  it('returns source="growthbook" when values are valid', () => {
    const result = loadFlagsWithFallback({
      growthbookValues: FLAG_DEFAULTS,
      env: {},
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('growthbook');
      expect(result.values).toEqual(FLAG_DEFAULTS);
    }
  });

  it('refuses to boot when growthbook is down and fallback is disabled', () => {
    const result = loadFlagsWithFallback({
      growthbookValues: null,
      env: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('growthbook_unreachable');
    }
  });

  it('falls back to defaults when growthbook is down and fallback is enabled', () => {
    const result = loadFlagsWithFallback({
      growthbookValues: null,
      env: { [FLAG_FALLBACK_ENV_VAR]: 'true' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('emergency_defaults');
      expect(result.values).toEqual(FLAG_DEFAULTS);
      expect(result.warning?.reason).toBe('growthbook_unreachable');
    }
  });

  it('refuses to boot when growthbook returns invalid values and fallback is disabled', () => {
    const result = loadFlagsWithFallback({
      growthbookValues: valid({ 'llm.kms.retry_count': 99 }),
      env: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('growthbook_invalid');
      expect(result.error).toBeInstanceOf(FlagValidationError);
    }
  });

  it('falls back to defaults when growthbook is invalid and fallback is enabled', () => {
    const bad = valid({ 'llm.kms.retry_count': 99 });
    const result = loadFlagsWithFallback({
      growthbookValues: bad,
      env: { [FLAG_FALLBACK_ENV_VAR]: 'true' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe('emergency_defaults');
      expect(result.warning?.reason).toBe('growthbook_invalid');
      expect(result.warning?.underlyingIssues?.[0]?.flag).toBe(
        'llm.kms.retry_count',
      );
    }
  });

  it('does not fall back for env values other than exactly "true"', () => {
    for (const v of ['TRUE', '1', 'yes', 'false', undefined]) {
      const result = loadFlagsWithFallback({
        growthbookValues: null,
        env: v === undefined ? {} : { [FLAG_FALLBACK_ENV_VAR]: v },
      });
      expect(result.ok).toBe(false);
    }
  });
});
