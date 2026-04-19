/**
 * Shared result type. Mirrors the shape of the §3.5 contract for
 * `LLMClient.call()`: a function never throws on anticipated failures,
 * and returns a discriminated result instead.
 *
 * Kept minimal on purpose. If a future iteration needs `map` / `unwrap`
 * helpers, they belong in a utility module, not on the type itself —
 * we do not want method identity to leak through serialisation.
 */

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** Convenience constructor: success. */
export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

/** Convenience constructor: failure. */
export function err<E>(error: E): { readonly ok: false; readonly error: E } {
  return { ok: false, error };
}
