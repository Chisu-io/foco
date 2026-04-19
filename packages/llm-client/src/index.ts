/**
 * Public surface of `@chisu/llm-client`.
 *
 * Iteration 1 scope: error taxonomy + classifiers + flag config.
 * Iteration 2 scope (this): envelope encryption (KEK-per-shard,
 *   DEK cache TTL ≤300s, zeroisation).
 * The `LLMClient.call()` surface (plan-aware routing, provider
 * dispatch) lands in Iteration 7 of the implementation plan.
 *
 * @see ../../../docs/LLM_CLIENT.md — the signed contract this
 *      package implements (v1.1 SIGNED, 2026-04-18).
 */

export * from './errors/index.js';
export * from './config/index.js';
export * from './crypto/index.js';
export * from './observability/index.js';
export { type Result, ok, err } from './types.js';
