import { describe, expect, it } from 'vitest';

import {
  InMemoryMetrics,
  NOOP_METRICS,
} from '../../src/observability/metrics.js';

describe('NOOP_METRICS', () => {
  it('accepts every call silently', () => {
    expect(() => NOOP_METRICS.counter('a')).not.toThrow();
    expect(() => NOOP_METRICS.histogram('b', 10)).not.toThrow();
    expect(() => NOOP_METRICS.gauge('c', 1)).not.toThrow();
  });

  it('is frozen', () => {
    expect(Object.isFrozen(NOOP_METRICS)).toBe(true);
  });
});

describe('InMemoryMetrics', () => {
  it('accumulates counter values with default +1 step', () => {
    const m = new InMemoryMetrics();
    m.counter('llm_dek_cache_hits_total');
    m.counter('llm_dek_cache_hits_total');
    expect(m.readCounter('llm_dek_cache_hits_total')).toBe(2);
  });

  it('supports explicit increment size', () => {
    const m = new InMemoryMetrics();
    m.counter('x', {}, 3);
    m.counter('x', {}, 7);
    expect(m.readCounter('x')).toBe(10);
  });

  it('keys by sorted labels (order-independent)', () => {
    const m = new InMemoryMetrics();
    m.counter('x', { a: '1', b: '2' });
    m.counter('x', { b: '2', a: '1' });
    expect(m.readCounter('x', { a: '1', b: '2' })).toBe(2);
  });

  it('records histogram samples as an array', () => {
    const m = new InMemoryMetrics();
    m.histogram('lat', 10, { op: 'e' });
    m.histogram('lat', 25, { op: 'e' });
    const samples = m.readHistogram('lat', { op: 'e' });
    expect(samples.map((s) => s.value)).toEqual([10, 25]);
  });

  it('gauge overwrites the previous value', () => {
    const m = new InMemoryMetrics();
    m.gauge('g', 1);
    m.gauge('g', 9);
    expect(m.readGauge('g')).toBe(9);
  });

  it('reads absent metrics as sensible defaults', () => {
    const m = new InMemoryMetrics();
    expect(m.readCounter('missing')).toBe(0);
    expect(m.readHistogram('missing')).toEqual([]);
    expect(m.readGauge('missing')).toBeUndefined();
  });

  it('derives kmsRetrySuccessRatio from retry counters', () => {
    const m = new InMemoryMetrics();
    m.counter('llm_kms_retries_total', {
      operation: 'encrypt',
      outcome: 'success',
    });
    m.counter('llm_kms_retries_total', {
      operation: 'encrypt',
      outcome: 'fail',
    });
    m.counter('llm_kms_retries_total', {
      operation: 'decrypt',
      outcome: 'success',
    });
    expect(m.kmsRetrySuccessRatio()).toBeCloseTo(2 / 3);
  });

  it('kmsRetrySuccessRatio is undefined with no samples', () => {
    expect(new InMemoryMetrics().kmsRetrySuccessRatio()).toBeUndefined();
  });
});
