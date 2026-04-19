/**
 * Minimal metrics interface used by the crypto layer.
 *
 * Iteration 2 ships only the abstraction + an in-memory implementation
 * for tests. Iteration 6 wires this to Mimir via OpenTelemetry, per
 * {@link ../../../../docs/LLM_CLIENT.md `LLM_CLIENT.md` §10.2}.
 *
 * Keeping the interface narrow avoids leaking OTel types into the
 * crypto layer and keeps call sites test-hermetic (no side channels
 * into a global metrics registry).
 *
 * Metric names emitted by the crypto layer:
 *
 *   llm_kms_latency_ms{operation=encrypt|decrypt}                histogram
 *   llm_kms_induced_failures_total{operation, transient}         counter
 *   llm_kms_retries_total{operation, outcome=success|fail}       counter
 *   llm_kms_retry_success_ratio                                  gauge (derived)
 *   llm_retries_skipped_deadline_total{operation}                counter
 *   llm_dek_cache_hits_total{}                                   counter
 *   llm_dek_cache_misses_total{}                                 counter
 *   llm_dek_cache_stale_hits_total{reason=version_mismatch}      counter
 *   llm_dek_cache_evictions_total{reason=ttl|manual}             counter
 *   llm_kek_shard_distribution{kek_version, shard_id}            gauge
 */

/**
 * Label bag attached to a metric sample. Only plain scalars are
 * accepted so the in-memory implementation can serialise labels
 * deterministically for assertions.
 */
export type MetricLabels = Readonly<Record<string, string | number | boolean>>;

/**
 * Narrow contract implemented by any metrics sink.
 *
 * All methods MUST be synchronous, non-throwing and allocation-free
 * on the hot path. The OTel implementation (Iteration 6) converts
 * labels to attribute sets eagerly.
 */
export interface Metrics {
  counter(name: string, labels?: MetricLabels, value?: number): void;
  histogram(name: string, valueMs: number, labels?: MetricLabels): void;
  gauge(name: string, value: number, labels?: MetricLabels): void;
}

/**
 * No-op sink. Use in production code paths that must tolerate a
 * missing metrics implementation (e.g. during the rebalance batch
 * which runs outside the worker process).
 */
export const NOOP_METRICS: Metrics = Object.freeze({
  counter(): void {},
  histogram(): void {},
  gauge(): void {},
});

/**
 * Deterministic serialisation of a label set. Keys are sorted so two
 * calls with labels `{a:1, b:2}` and `{b:2, a:1}` land in the same
 * bucket.
 */
function serialiseLabels(labels: MetricLabels | undefined): string {
  if (labels === undefined) return '';
  const keys = Object.keys(labels).sort();
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(`${k}=${String(labels[k])}`);
  }
  return parts.join(',');
}

/**
 * One observed sample of a histogram. Kept small so tests can assert
 * on exact values without pulling in a full histogram library.
 */
export interface HistogramSample {
  readonly value: number;
  readonly labels: MetricLabels | undefined;
}

/**
 * In-memory Metrics sink for unit tests. Exposes the raw counters,
 * histograms and gauges so tests can assert on cardinality without
 * a time-series backend.
 *
 * Keys in the `counters` / `histograms` / `gauges` maps are
 * `${metricName}|${serialisedLabels}`.
 */
export class InMemoryMetrics implements Metrics {
  readonly counters = new Map<string, number>();
  readonly histograms = new Map<string, HistogramSample[]>();
  readonly gauges = new Map<string, number>();

  counter(name: string, labels?: MetricLabels, value: number = 1): void {
    const key = `${name}|${serialiseLabels(labels)}`;
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  histogram(name: string, valueMs: number, labels?: MetricLabels): void {
    const key = `${name}|${serialiseLabels(labels)}`;
    const bucket = this.histograms.get(key);
    const sample: HistogramSample = {
      value: valueMs,
      labels,
    };
    if (bucket) {
      bucket.push(sample);
    } else {
      this.histograms.set(key, [sample]);
    }
  }

  gauge(name: string, value: number, labels?: MetricLabels): void {
    const key = `${name}|${serialiseLabels(labels)}`;
    this.gauges.set(key, value);
  }

  /** Convenience lookup for counter assertions. Returns 0 when absent. */
  readCounter(name: string, labels?: MetricLabels): number {
    return this.counters.get(`${name}|${serialiseLabels(labels)}`) ?? 0;
  }

  /** Convenience lookup for histogram assertions. Returns `[]` when absent. */
  readHistogram(name: string, labels?: MetricLabels): readonly HistogramSample[] {
    return this.histograms.get(`${name}|${serialiseLabels(labels)}`) ?? [];
  }

  /** Convenience lookup for gauge assertions. Returns `undefined` when absent. */
  readGauge(name: string, labels?: MetricLabels): number | undefined {
    return this.gauges.get(`${name}|${serialiseLabels(labels)}`);
  }

  /**
   * Derived: `llm_kms_retry_success_ratio` from the recorded
   * `llm_kms_retries_total{outcome}` counters (§10.2 operational note).
   *
   * Exposed here — not in the `Metrics` interface — because it is a
   * *test helper*, not something OTel computes client-side.
   */
  kmsRetrySuccessRatio(): number | undefined {
    let success = 0;
    let fail = 0;
    for (const [key, count] of this.counters.entries()) {
      if (!key.startsWith('llm_kms_retries_total|')) continue;
      if (key.includes('outcome=success')) success += count;
      else if (key.includes('outcome=fail')) fail += count;
    }
    const total = success + fail;
    return total === 0 ? undefined : success / total;
  }
}
