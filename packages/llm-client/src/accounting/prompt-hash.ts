/**
 * Deterministic SHA-256 hash of a normalized LLM request, used by the
 * accounting layer for the `llm_token_usage.prompt_hash` column (§8.1
 * of the signed contract) and by the abuse detector worker (§8.3
 * "prompt_spam" heuristic, iter 8+).
 *
 * ## Why the hash is here and not on the writer
 *
 * The hash must be computed **before** the provider call because:
 *
 *  1. The writer never sees the `NormalizedLLMRequest` — only the
 *     flattened `UsageEntry`. Pushing the hash computation upstream
 *     keeps the writer dumb (one I/O concern, no serialisation logic).
 *  2. On write failure, the entry is buffered with the hash already
 *     embedded — the canonical input may no longer be in memory by the
 *     time the buffer flushes.
 *  3. The abuse detector only ever sees the stored hash; it never
 *     re-hashes. Centralising the algorithm here makes
 *     "retry-produces-the-same-hash" enforceable by a single test.
 *
 * ## Canonicalisation rules
 *
 *  - Object keys are sorted lexicographically, recursively.
 *  - Arrays preserve order (the order carries meaning — message
 *    sequence, tool-call sequence).
 *  - `undefined` keys are dropped (matches `JSON.stringify` behaviour).
 *  - `null` is preserved.
 *  - Strings are UTF-8 encoded by `crypto.createHash(...).update(s, 'utf8')`.
 *
 * Input canonical format:
 *
 *     ${systemPrompt ?? ''}
 *     ---
 *     ${messages.map(canonicalize).join('\n')}
 *
 * The literal `'\n---\n'` separator is **not** legal in the body of
 * any normalized message (the `role` field is closed) so it cannot
 * collide with real content across role boundaries.
 *
 * ## Hash choice — full SHA-256 hex, not truncated
 *
 * Design doc §3.2 + §8 decisión firmada #1: the 64-char hex form is
 * kept because (a) it is bit-for-bit comparable with the hashes the
 * audit sink already emits, keeping operator mental model uniform, and
 * (b) the cost is < 1µs per call on Node 20 — negligible relative to
 * the 100ms+ provider round-trip this is paired with.
 *
 * @see docs/LLM_CLIENT.md §8.1, §8.3
 * @see .cmsgs/iter7-accounting-design.md §3.2 + §8 decisión #1
 */

import { createHash } from 'node:crypto';

import type { NormalizedLLMRequest } from '../types/request.js';

/**
 * The separator between the system prompt and the message sequence in
 * the canonical form. Exposed as a named constant so test assertions
 * that reconstruct the canonical string don't hand-keep a literal.
 */
export const PROMPT_HASH_SEPARATOR = '\n---\n';

/**
 * Stable JSON stringifier: objects have their keys sorted; arrays
 * preserve order; `undefined` values are dropped; `null` is kept.
 *
 * Kept private to this module — callers should only reach the
 * publicly stable `hashNormalizedRequest` entry point below. Exposing
 * the canonical form as a raw string would make it too easy to
 * accidentally hash diverging shapes from two call sites.
 */
function stableStringify(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const parts = value.map((v) => stableStringify(v));
    return `[${parts.join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts: string[] = [];
    for (const k of keys) {
      const v = obj[k];
      if (v === undefined) continue; // matches JSON.stringify
      parts.push(`${JSON.stringify(k)}:${stableStringify(v)}`);
    }
    return `{${parts.join(',')}}`;
  }
  // `undefined`, symbols, functions — match JSON.stringify (drop /
  // return `undefined` which callers skip). Returning a sentinel
  // would silently widen the hash surface, so we return the literal
  // `"null"` to preserve positional stability inside arrays.
  return 'null';
}

/**
 * Render the canonical string that will be fed into SHA-256. Visible
 * to tests in this module only — the public API below exposes the
 * hashed digest, not the pre-image.
 */
function canonicalize(request: NormalizedLLMRequest): string {
  const system = request.systemPrompt ?? '';
  const messageLines = request.messages
    .map((m) => stableStringify(m))
    .join('\n');
  return `${system}${PROMPT_HASH_SEPARATOR}${messageLines}`;
}

/**
 * Deterministic 64-char lowercase hex digest of the request.
 *
 * Guarantees (enforced by the test suite):
 *
 *  - Idempotent: same request → same digest across processes and
 *    retries.
 *  - Order-invariant on object keys: two requests that differ only in
 *    key ordering inside `toolDefinitions[].parameters` produce the
 *    same digest.
 *  - Order-sensitive on message sequence: reordering `messages[]`
 *    produces a different digest (the sequence carries meaning).
 *  - `systemPrompt` absent vs. empty string produce the same digest
 *    (both normalise to `''`) — this is intentional because provider
 *    adapters themselves already treat them the same.
 */
export function hashNormalizedRequest(request: NormalizedLLMRequest): string {
  const canonical = canonicalize(request);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}
