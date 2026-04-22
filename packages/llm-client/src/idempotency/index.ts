/**
 * Public surface of the idempotency module.
 *
 * Shipped in iteration 8 commit 1. The facade in `src/client.ts`
 * consumes these symbols; there are no production consumers outside
 * the package.
 *
 * @see .cmsgs/iter8-prompt.md — "Archivos a crear"
 */

export {
  DEFAULT_IDEMPOTENCY_CAPACITY,
  IDEMPOTENCY_HITS_COUNTER,
  IDEMPOTENCY_MISSES_COUNTER,
  InMemoryIdempotencyStore,
} from './store.js';

export type {
  IdempotencyStore,
  InMemoryIdempotencyStoreOptions,
} from './store.js';

export { IDEMPOTENCY_KEY_SEPARATOR, buildIdempotencyKey } from './key.js';
