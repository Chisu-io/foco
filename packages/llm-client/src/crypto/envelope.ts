/**
 * Envelope encryption — the user-facing composition of
 * {@link ./sharding.js}, {@link ./dek.js} and {@link ./kek.js}.
 *
 * Implements the write- and read-side flows of
 * {@link ../../../../docs/LLM_CLIENT.md `LLM_CLIENT.md` §5.1} and the
 * `(userId, kekVersion)` cache contract of §2 invariant 8.
 *
 * Cache policy (§2 invariant 8):
 *
 *  - Key = `${userId}:${kekVersion}`. **NOT** just `userId`.
 *  - TTL ≤ 300 000 ms (hard-capped in the constructor — cannot be
 *    raised by flag; §16 `llm.dek_cache.ttl_seconds.max = 300`).
 *  - Zeroised on eviction (TTL expiry, manual invalidation, and
 *    stale-version purge).
 *  - {@link EnvelopeCrypto.invalidateUserKey} removes **every** entry
 *    whose user id matches — cross-version — not just the current one.
 *  - Process-local only. Never serialised, never shared across workers.
 *
 * Metrics emitted (§10.2):
 *
 *   llm_dek_cache_hits_total
 *   llm_dek_cache_misses_total
 *   llm_dek_cache_stale_hits_total{reason=version_mismatch}
 *   llm_dek_cache_evictions_total{reason=ttl|manual|stale}
 *
 * `stale` is an implementation-level sub-reason added here so
 * operators can break down the reason counter in Grafana without
 * losing the §5.1 signal.
 */

import type { KMSClient } from '@aws-sdk/client-kms';
import {
  SpanKind,
  SpanStatusCode,
  context,
  trace,
} from '@opentelemetry/api';

import type { LLMCallError } from '../errors/taxonomy.js';
import { make } from '../errors/taxonomy.js';
import type { Metrics } from '../observability/metrics.js';
import { getTracer } from '../observability/tracing.js';
import type { ProviderName } from '../providers/provider.js';
import { err, ok, type Result } from '../types.js';
import {
  decryptWithDek,
  encryptWithDek,
  generateDek,
  zeroize,
  type DekCiphertext,
} from './dek.js';
import {
  defaultJitterMs,
  defaultSleep,
  kekAlias,
  kmsDecrypt,
  kmsEncrypt,
  type KmsCallOptions,
  type KmsDeps,
} from './kek.js';
import { shardId } from './sharding.js';

/** The hard cap on DEK cache TTL, from §2 invariant 8 / §16. */
export const MAX_DEK_CACHE_TTL_MS = 300_000;

/**
 * Persisted envelope shape. Maps 1:1 to the `user_llm_key` columns
 * listed in §5.1 step 6.
 */
export interface Envelope {
  readonly kekVersion: number;
  readonly shardId: number;
  /** DEK encrypted by KMS (opaque blob). */
  readonly dekCiphertext: Uint8Array;
  /** User API key encrypted by DEK (AES-256-GCM). */
  readonly keyCiphertext: Uint8Array;
  /** 12-byte GCM nonce. */
  readonly keyNonce: Uint8Array;
  /** 16-byte GCM auth tag. */
  readonly keyAuthTag: Uint8Array;
}

/** Dependencies + config for {@link EnvelopeCrypto}. */
export interface EnvelopeDeps {
  readonly kms: KMSClient;
  readonly metrics: Metrics;
  /** `Date.now`-compatible clock. Injected for hermetic tests. */
  readonly now: () => number;
  /**
   * Returns the `kekVersion` under which new envelopes should be
   * written. Reads from deploy config in production (§5.1 step 5).
   */
  readonly currentKekVersion: () => number;
  /** DEK-cache TTL in ms. Hard-capped at {@link MAX_DEK_CACHE_TTL_MS}. */
  readonly cacheTtlMs: number;
  /** Sleep override (default: real `setTimeout`). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Jitter override (default: real `Math.random`). */
  readonly jitterMs?: (min: number, max: number) => number;
}

/** Inputs to {@link EnvelopeCrypto.wrap}. */
export interface WrapInput {
  readonly userId: string;
  /**
   * User API key in plaintext. The caller retains ownership; we do
   * **not** zeroise it — the edge does that at §5.1 step 8 after the
   * envelope has been persisted.
   */
  readonly keyPlaintext: Buffer;
  readonly deadlineMs?: number | undefined;
}

/** Inputs to {@link EnvelopeCrypto.unwrap}. */
export interface UnwrapInput {
  readonly userId: string;
  readonly envelope: Envelope;
  readonly deadlineMs?: number | undefined;
  /**
   * Provider to which this envelope's plaintext API key belongs.
   * Required so the `llm.kms.decrypt_dek` sub-span (§10.1, signed
   * 2026-04-18) can stamp `llm.provider` without re-introducing
   * routing inside the crypto module. The caller (plan-router / BYOK
   * resolver) always resolves the provider before asking for a DEK —
   * propagating it through the API is cheaper than re-deriving it
   * here.
   *
   * Type-level gate: a future concrete BYOK resolver that forgets to
   * pass `provider` will fail typecheck. That is the enforcement
   * commit 4 relies on; no runtime call-site exists in `src/` yet
   * (iter 7 facade or a dedicated `BYOKKeystore` commit).
   */
  readonly provider: ProviderName;
}

interface CacheEntry {
  readonly dek: Buffer;
  readonly kekVersion: number;
  /** Absolute expiry timestamp (ms). */
  expiresAt: number;
}

/**
 * Stateful envelope-crypto façade.
 *
 * A single instance is created per worker process. It owns the DEK
 * cache and wraps the stateless KMS helpers. All public methods are
 * `async` and never throw on anticipated failures — they return
 * `Result<..., LLMCallError>`.
 */
export class EnvelopeCrypto {
  private readonly deps: EnvelopeDeps;
  private readonly kmsDeps: KmsDeps;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(deps: EnvelopeDeps) {
    if (!Number.isFinite(deps.cacheTtlMs) || deps.cacheTtlMs < 0) {
      throw new Error(
        `EnvelopeCrypto: cacheTtlMs must be a non-negative finite number ` +
          `(got ${deps.cacheTtlMs}).`,
      );
    }
    if (deps.cacheTtlMs > MAX_DEK_CACHE_TTL_MS) {
      throw new Error(
        `EnvelopeCrypto: cacheTtlMs ${deps.cacheTtlMs}ms exceeds the ` +
          `§2 invariant 8 / §16 hard-cap of ${MAX_DEK_CACHE_TTL_MS}ms. ` +
          'Raising this requires a bump of LLM_CLIENT.md, not a code change.',
      );
    }
    this.deps = deps;
    this.kmsDeps = {
      kms: deps.kms,
      metrics: deps.metrics,
      now: deps.now,
      sleep: deps.sleep ?? defaultSleep,
      jitterMs: deps.jitterMs ?? defaultJitterMs,
    };
  }

  /**
   * Build a fresh envelope for `userId` from a plaintext API key.
   *
   * Called once by the edge per `.setKey()` / rotation; not on the
   * worker hot path. Does **not** populate the DEK cache — the edge
   * and the worker are separate processes (§5.1 threat model), so
   * priming would leak the DEK cross-process.
   */
  async wrap(input: WrapInput): Promise<Result<Envelope, LLMCallError>> {
    if (!input.userId) {
      return err(make.internal('envelope.wrap: empty userId'));
    }

    const kekVersion = this.deps.currentKekVersion();
    const sid = shardId(input.userId, kekVersion);
    const alias = kekAlias({ kekVersion, shardId: sid });

    const dek = generateDek();
    try {
      const kmsOpts: KmsCallOptions =
        input.deadlineMs === undefined
          ? {}
          : { deadlineMs: input.deadlineMs };
      const encryptedDek = await kmsEncrypt(
        this.kmsDeps,
        { alias, plaintext: new Uint8Array(dek) },
        kmsOpts,
      );
      if (!encryptedDek.ok) return err(encryptedDek.error);

      const body = encryptWithDek(input.keyPlaintext, dek);
      return ok({
        kekVersion,
        shardId: sid,
        dekCiphertext: encryptedDek.value,
        keyCiphertext: new Uint8Array(body.ciphertext),
        keyNonce: new Uint8Array(body.nonce),
        keyAuthTag: new Uint8Array(body.authTag),
      });
    } finally {
      // Even on success — the edge does not need the raw DEK back.
      zeroize(dek);
    }
  }

  /**
   * Decrypt the user API key inside an `envelope`.
   *
   * Cache flow (see §5.1 read flow):
   *
   *  1. Look up `(userId, envelope.kekVersion)`. If present and fresh,
   *     reuse the DEK.
   *  2. If expired, zeroise + evict + count `evictions{reason=ttl}`,
   *     then fall through.
   *  3. Any other cache entry for the same `userId` but a different
   *     `kekVersion` is a stale row from a past rotation. Zeroise +
   *     evict + count `stale_hits_total{reason=version_mismatch}` and
   *     `evictions{reason=stale}`.
   *  4. On miss, call KMS Decrypt, populate cache.
   *
   * The returned plaintext Buffer is owned by the caller — zeroising
   * it after use is the caller's responsibility (§5.1 step 5).
   */
  async unwrap(input: UnwrapInput): Promise<Result<Buffer, LLMCallError>> {
    if (!input.userId) {
      return err(make.internal('envelope.unwrap: empty userId'));
    }
    const { userId, envelope } = input;
    const currentKey = cacheKeyOf(userId, envelope.kekVersion);
    const now = this.deps.now();

    let dek: Buffer;

    const existing = this.cache.get(currentKey);
    if (existing !== undefined && existing.expiresAt > now) {
      this.deps.metrics.counter('llm_dek_cache_hits_total');
      dek = existing.dek;
    } else {
      // Evict current-key expired entry first.
      if (existing !== undefined) {
        zeroize(existing.dek);
        this.cache.delete(currentKey);
        this.deps.metrics.counter('llm_dek_cache_evictions_total', {
          reason: 'ttl',
        });
      }

      // Purge any entry for this user under a *different* kekVersion.
      this.purgeStaleVersions(userId, envelope.kekVersion);

      this.deps.metrics.counter('llm_dek_cache_misses_total');

      const alias = kekAlias({
        kekVersion: envelope.kekVersion,
        shardId: envelope.shardId,
      });
      const kmsOpts: KmsCallOptions =
        input.deadlineMs === undefined
          ? {}
          : { deadlineMs: input.deadlineMs };

      // §10.1 sub-span: `llm.kms.decrypt_dek`.
      // Emitted ONLY on cache-miss (§8 decisión #2 del mini-spec
      // `iter6-otel-correlation-design.md` — cache-hit no emite).
      // Patrón manual (NO `withSpan`): `kmsDecrypt` devuelve
      // `Result<_, LLMCallError>`, no throw. `withSpan` auto-estamparía
      // `SpanStatusCode.OK` en el return y pisaría el `ERROR` manual
      // que debe quedar en el branch `Result.err` (viola R3 del
      // mini-spec). `LLMCallError` es tagged union, no `Error` — así
      // que NO llamamos `recordException` sobre el Result.err (el
      // stack no pertenece al error real). Mismo patrón aplicado en
      // `plan-router.ts` líneas 635-708 (commit 3, `stampRootSpanClose`).
      //
      // Contexto activo: `context.with(trace.setSpan(..., kmsSpan), fn)`
      // propaga el parent en producción (donde el host instala
      // `AsyncHooksContextManager`). Los hermetic tests de este package
      // no instalan el context manager, así que aserten presencia del
      // span + atributos + count, no `parentSpanId`. Mismo criterio que
      // commit 3 (ver plan-router.ts líneas 674-677).
      const tracer = getTracer();
      const kmsSpan = tracer.startSpan('llm.kms.decrypt_dek', {
        kind: SpanKind.CLIENT,
        attributes: {
          'llm.provider': input.provider,
          'kek.version': envelope.kekVersion,
          'kek.shard_id': envelope.shardId,
        },
      });

      let decrypted: Result<Uint8Array, LLMCallError>;
      try {
        decrypted = await context.with(
          trace.setSpan(context.active(), kmsSpan),
          () =>
            kmsDecrypt(
              this.kmsDeps,
              { alias, ciphertext: envelope.dekCiphertext },
              kmsOpts,
            ),
        );
        if (decrypted.ok) {
          kmsSpan.setStatus({ code: SpanStatusCode.OK });
        } else {
          // R3: `LLMCallError` es tagged union, no `Error`.
          // NO llamar `recordException` — mentiría sobre el stack.
          kmsSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: decrypted.error.kind,
          });
        }
      } finally {
        kmsSpan.end();
      }

      if (!decrypted.ok) return err(decrypted.error);

      // Copy so the cache owns the Buffer lifecycle.
      dek = Buffer.from(decrypted.value);
      // Zeroise the SDK-provided blob once we no longer need it.
      zeroize(decrypted.value);

      this.cache.set(currentKey, {
        dek,
        kekVersion: envelope.kekVersion,
        expiresAt: now + this.deps.cacheTtlMs,
      });
    }

    const cipher: DekCiphertext = {
      ciphertext: Buffer.from(envelope.keyCiphertext),
      nonce: Buffer.from(envelope.keyNonce),
      authTag: Buffer.from(envelope.keyAuthTag),
    };

    try {
      const plaintext = decryptWithDek(cipher, dek);
      return ok(plaintext);
    } catch (_e) {
      // GCM auth failure after a successful KMS Decrypt means the row
      // has been tampered with at rest. Not a user-addressable error —
      // `internal` with a correlation id per §7.3.
      return err(make.internal(`envelope.unwrap: auth-tag mismatch`));
    }
  }

  /**
   * Purge every cache entry for `userId`, regardless of `kekVersion`.
   * Returns how many entries were removed (useful for tests / alerts).
   *
   * Called on §5.3 key revocation and on explicit user-driven
   * rotations. The caller must ALSO update DB state — this only
   * drops the process-local cache.
   */
  invalidateUserKey(userId: string): number {
    let removed = 0;
    const prefix = `${userId}\u0000`;
    for (const [key, entry] of this.cache.entries()) {
      if (key.startsWith(prefix)) {
        zeroize(entry.dek);
        this.cache.delete(key);
        this.deps.metrics.counter('llm_dek_cache_evictions_total', {
          reason: 'manual',
        });
        removed++;
      }
    }
    return removed;
  }

  /**
   * Best-effort periodic sweep for tests and for the §5.3 runbook.
   * Evicts every expired entry and returns how many were removed.
   * Production workers rely on the lazy eviction inside `unwrap`;
   * this exists so tests can assert TTL behaviour without advancing
   * real time.
   */
  sweepExpired(): number {
    const now = this.deps.now();
    let removed = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt <= now) {
        zeroize(entry.dek);
        this.cache.delete(key);
        this.deps.metrics.counter('llm_dek_cache_evictions_total', {
          reason: 'ttl',
        });
        removed++;
      }
    }
    return removed;
  }

  /** Size of the cache — for tests and shard-distribution gauges. */
  get size(): number {
    return this.cache.size;
  }

  private purgeStaleVersions(userId: string, currentVersion: number): void {
    const prefix = `${userId}\u0000`;
    for (const [key, entry] of this.cache.entries()) {
      if (key.startsWith(prefix) && entry.kekVersion !== currentVersion) {
        zeroize(entry.dek);
        this.cache.delete(key);
        this.deps.metrics.counter('llm_dek_cache_stale_hits_total', {
          reason: 'version_mismatch',
        });
        this.deps.metrics.counter('llm_dek_cache_evictions_total', {
          reason: 'stale',
        });
      }
    }
  }
}

/**
 * Serialise `(userId, kekVersion)` into a map key. Uses `\u0000`
 * between fields because `userId` strings may legitimately contain
 * `:` / `-` / digits; a NUL byte cannot appear in a valid UUID or
 * alphanumeric identifier, so it is a safe separator.
 */
function cacheKeyOf(userId: string, kekVersion: number): string {
  return `${userId}\u0000${kekVersion}`;
}
