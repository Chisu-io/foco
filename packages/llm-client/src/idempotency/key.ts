/**
 * Deterministic idempotency-key builder.
 *
 * Implements the "idempotency.key" decision of
 * {@link ../../../../.cmsgs/iter8-prompt.md `iter8-prompt.md`}:
 *
 *     key = sha256(userId + ':' + promptHash + ':' + model)
 *
 * The `promptHash` input is expected to already be the 64-char
 * lowercase hex digest produced by
 * {@link ../accounting/prompt-hash.ts `hashNormalizedRequest`}
 * (§8 decisión firmada #1: full SHA-256, not truncated). The facade
 * computes it once per `call()` and passes it to both the accounting
 * writer and this key builder, so the hash is stable end-to-end.
 *
 * ## Why we hash over concatenation instead of just joining
 *
 * Two motives:
 *
 *  1. Opacity. The idempotency key ends up in log lines, metric
 *     context, and the future Redis impl's key space. Any of those
 *     seeing `"userId:promptHash:model"` verbatim would leak the
 *     user's raw id, which the rest of the package hashes (see
 *     `hashUserId` in `observability/tracing.ts`). Hashing the
 *     concatenation makes the key a fixed-length opaque digest.
 *
 *  2. Collision resistance across separator choice. Using `:` as a
 *     separator with raw `userId`/`model` values runs the risk of an
 *     ill-formed `userId` that itself contains `:` colliding across
 *     key tuples. A SHA-256 over the concatenated form is
 *     collision-resistant in practice (2^128 birthday bound) — the
 *     separator choice is documentation, not a security primitive.
 *
 * ## Separator constant
 *
 * Exported as {@link IDEMPOTENCY_KEY_SEPARATOR} so tests reconstructing
 * the canonical pre-hash form don't hand-keep a literal; matches the
 * `PROMPT_HASH_SEPARATOR` convention in `accounting/prompt-hash.ts`.
 *
 * @see LLM_CLIENT.md §4 — Latency & Idempotency
 * @see .cmsgs/iter8-prompt.md — "idempotency.key" decision
 */

import { createHash } from 'node:crypto';

/**
 * Literal separator between `userId`, `promptHash` and `model` before
 * hashing. Kept exported so tests can rebuild the canonical string
 * without hand-keeping `':'`. Do not change — the hash output is a
 * public function of this constant.
 */
export const IDEMPOTENCY_KEY_SEPARATOR = ':';

/**
 * Build the idempotency key for a `call(input, options?)`.
 *
 * Requirements on the inputs are caller-enforced:
 *
 *  - `userId` must be non-empty (the facade parses inputs via zod
 *    before reaching this builder, so an empty id would already have
 *    been rejected as `internal`).
 *  - `promptHash` must be the 64-char lowercase hex SHA-256 digest
 *    produced by `hashNormalizedRequest`. This is not re-validated
 *    here — the hash appears in exactly one production call site (the
 *    facade) and round-trips through a typed function.
 *  - `model` is the original requested model, NOT the resolved
 *    `modelUsed` — idempotency is about request-shape equality, and
 *    fallbacks to a different model still serve the original request.
 *  - `callerKey` is an optional `LLMCallInput.idempotencyKey` passed
 *    by the caller (cron, worker job id, replayable test fixture).
 *    When provided and non-empty it is hashed together with `userId`
 *    so the same `callerKey` value cannot collide across tenants
 *    (LLM_CLIENT.md §18.2). When `undefined` or empty, the builder
 *    falls back to the original 3-tuple derivation so existing
 *    cache entries from iter 8 remain reachable.
 *
 * Output is the 64-char lowercase hex SHA-256 of the canonical
 * pre-image:
 *
 *  - without override: `${userId}:${promptHash}:${model}`
 *  - with override:    `${userId}:${callerKey}:${promptHash}:${model}`
 *
 * The two pre-image shapes are intentionally distinct by length and
 * structure, so a caller-provided key and a derived key over the same
 * `(userId, promptHash, model)` cannot produce the same digest.
 */
export function buildIdempotencyKey(
  userId: string,
  promptHash: string,
  model: string,
  callerKey?: string,
): string {
  const sep = IDEMPOTENCY_KEY_SEPARATOR;
  const preImage =
    typeof callerKey === 'string' && callerKey.length > 0
      ? `${userId}${sep}${callerKey}${sep}${promptHash}${sep}${model}`
      : `${userId}${sep}${promptHash}${sep}${model}`;
  return createHash('sha256').update(preImage, 'utf8').digest('hex');
}
