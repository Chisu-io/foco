/**
 * Public subpath export for the provider adapter layer.
 *
 * The three MVP adapters (Anthropic, OpenAI, Gemini) are exported as
 * factory functions rather than classes. Factories take an optional
 * `deps` argument so tests can inject a fake `HttpClient` without
 * mocking `global.fetch`.
 *
 * @see LLM_CLIENT.md §9 — Providers (MVP v1.1)
 * @see ./provider.ts for the Provider interface and invariants.
 */

export type {
  Provider,
  ProviderCallInput,
  ProviderPingInput,
} from './provider.js';
// Note: `ProviderName` is re-exported from the top-level `./errors`
// subpath (the canonical declaration site per §9.4). Keeping a single
// authoritative declaration avoids `export *` re-export ambiguity.

export {
  createAnthropicProvider,
  ANTHROPIC_API_VERSION,
  ANTHROPIC_CALL_TIMEOUT_MS,
  ANTHROPIC_ENDPOINT,
  ANTHROPIC_PING_MODEL,
  ANTHROPIC_PING_TIMEOUT_MS,
  type AnthropicDeps,
} from './anthropic.js';

export {
  createOpenAIProvider,
  OPENAI_CALL_TIMEOUT_MS,
  OPENAI_ENDPOINT,
  OPENAI_PING_MODEL,
  OPENAI_PING_TIMEOUT_MS,
  type OpenAIDeps,
} from './openai.js';

export {
  createGeminiProvider,
  GEMINI_CALL_TIMEOUT_MS,
  GEMINI_ENDPOINT_BASE,
  GEMINI_PING_MODEL,
  GEMINI_PING_TIMEOUT_MS,
  type GeminiDeps,
} from './gemini.js';
