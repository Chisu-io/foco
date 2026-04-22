/**
 * Cross-layer clock primitive.
 *
 * `Clock` is the tiniest possible shape — a `() => number` returning
 * milliseconds since the Unix epoch — that lets every subsystem that
 * needs to know "when is it?" be driven from a single injection point.
 * Tests replace it with a `ManualClock` or similar step-advance fake;
 * production uses `defaultClock` which delegates to {@link Date.now}.
 *
 * ## Why the primitive lives at the package root
 *
 * Iteration 8 is the first iteration where three sibling modules
 * (`idempotency`, `scheduler`, `client`) share a single clock. Before
 * iter 8 each module that needed a clock declared its own module-local
 * alias (see `ConsentClock` in `accounting/consent.ts`), which was fine
 * when the clock was an implementation detail of one module — but the
 * iter 8 facade wires these three pieces together with a common
 * `deps.clock`, so a shared primitive is strictly required.
 *
 * The type is kept to `() => number` (rather than `interface Clock {
 * now(): number }`) for three reasons:
 *
 *  1. Matches the existing convention (`ConsentClock = () => number`).
 *  2. `Date.now` is assignable without a wrapper — the production
 *     default is literally `defaultClock = Date.now`.
 *  3. A unary function is easier to stub inline (`const clock = () =>
 *     now`) than an interface, which matters because most test cases
 *     only need a fixed timestamp.
 *
 * Not exported from the public package barrel: the clock is a DI seam
 * for internal composition, not a consumer API.
 *
 * @see docs/LLM_CLIENT.md §4 (deadline propagation)
 * @see .cmsgs/iter8-prompt.md "Shape mínimo"
 */

/**
 * Millisecond-precision monotonic-ish clock. "Monotonic-ish" because
 * {@link Date.now} can jump on NTP adjustments; we accept that —
 * the clock is used for TTL expiry and timer scheduling, not for
 * ordering safety-critical events.
 */
export type Clock = () => number;

/**
 * Production default. Tests should never import this — they should
 * inject a `ManualClock.now` (see `test/accounting/_fakes.ts`) so
 * TTL / scheduler specs do not depend on wall-clock drift.
 */
export const defaultClock: Clock = Date.now;
