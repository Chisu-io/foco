/**
 * Public surface of `@chisu/llm-client/scheduler`.
 *
 * Iter 8 commit 2 exports the `FlushScheduler` and the three scalar
 * constants a caller needs to construct one without cross-importing
 * the implementation module. No internal types leak.
 *
 * @see ./flush-scheduler.ts
 */

export {
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_FLUSH_THRESHOLD_FRACTION,
  FLUSH_SCHEDULER_RUNS_COUNTER,
  FlushScheduler,
  type FlushSchedulerDeps,
  type FlushTrigger,
} from './flush-scheduler.js';
