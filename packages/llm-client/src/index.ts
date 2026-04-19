/**
 * Public surface of `@chisu/llm-client`.
 *
 * Iteration 1 scope: error taxonomy + classifiers + flag config.
 * The `LLMClient.call()` surface (envelope encryption, plan-aware
 * routing, provider dispatch) lands in Iteration 7 of the
 * implementation plan.
 *
 * @see ../../../docs/LLM_CLIENT.md — the signed contract this
 *      package implements (v1.1 SIGNED, 2026-04-18).
 */

export * from './errors/index.js';
export * from './config/index.js';
