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
 *
 * Output is the 64-char lowercase hex SHA-256 of
 * `${userId}:${promptHash}:${model}`.
 */
export function buildIdempotencyKey(
  userId: string,
  promptHash: string,
  model: string,
): string {
  return createHash('sha256')
    .update(
      `${userId}${IDEMPOTENCY_KEY_SEPARATOR}${promptHash}${IDEMPOTENCY_KEY_SEPARATOR}${model}`,
      'utf8',
    )
    .digest('hex');
}
