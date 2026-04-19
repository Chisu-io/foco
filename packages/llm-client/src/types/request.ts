/**
 * Normalized request shapes for `@chisu/llm-client`.
 *
 * Verbatim with the signed contract in
 * {@link ../../../../docs/LLM_CLIENT.md `LLM_CLIENT.md` §3.3}. Any
 * change here requires a bump + signature per
 * `feedback_foco_three_contracts_rule`.
 *
 * These shapes are **provider-agnostic**. Each adapter in `../providers/`
 * owns the translation from `NormalizedLLMRequest` to the wire format
 * of its proveedor (Anthropic Messages, OpenAI Chat Completions,
 * Gemini generateContent) and the inverse translation for responses.
 *
 * Invariant: adapters MUST NOT mutate the input request. They produce
 * a wire-format payload and hand it to the HTTP client.
 */

/**
 * Canonical model identifiers accepted by the client. The union is
 * kept narrow on purpose — adding a model here forces a contract
 * signature (§9 "Providers" of the contract).
 *
 * MVP v1.1: Anthropic `claude-opus-4-6`, `claude-sonnet-4-6`,
 * `claude-haiku-4-5`; OpenAI `gpt-5`, `gpt-5-mini`; Gemini
 * `gemini-2.5-pro`, `gemini-2.5-flash`.
 */
export type ModelId =
  | 'claude-opus-4-6'
  | 'claude-sonnet-4-6'
  | 'claude-haiku-4-5'
  | 'gpt-5'
  | 'gpt-5-mini'
  | 'gemini-2.5-pro'
  | 'gemini-2.5-flash';

/**
 * Content block used inside a `NormalizedMessage.content` array. The
 * v1.1 MVP supports only text and tool results. Image / file blocks
 * land in a later iteration together with multimodal ingest.
 *
 * Note: the shape favours the `{ type: ... }` discriminant over a
 * free-form object so adapters can switch exhaustively without
 * stringly-typed checks.
 */
export type NormalizedContentBlock =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'tool_use';
      readonly toolUseId: string;
      readonly toolName: string;
      readonly input: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: 'tool_result';
      readonly toolUseId: string;
      readonly output: string;
      readonly isError?: boolean | undefined;
    };

/**
 * A single message in a conversation. `content` may be a convenience
 * string (interpreted as a single `text` block by adapters) or an
 * explicit array of blocks.
 *
 * Roles follow the OpenAI/Anthropic convention; Gemini's wire format
 * uses `'model'` instead of `'assistant'` — that translation happens
 * inside the Gemini adapter, not here.
 */
export interface NormalizedMessage {
  readonly role: 'user' | 'assistant' | 'tool';
  readonly content: string | readonly NormalizedContentBlock[];
}

/**
 * Tool definition (JSON Schema for parameters). Mirrors the shape of
 * Anthropic's `tools[]` entry and maps cleanly to OpenAI's
 * `tools[].function` and Gemini's `functionDeclarations[]`.
 */
export interface NormalizedTool {
  readonly name: string;
  readonly description: string;
  /**
   * JSON Schema draft-07-compatible. The client does not validate
   * the schema itself — that is the caller's responsibility.
   */
  readonly parameters: Readonly<Record<string, unknown>>;
}

/**
 * Output format hint. `json_object` forces structured output and is
 * mapped to each provider's native mechanism (OpenAI `response_format`,
 * Gemini `response_mime_type`, Anthropic JSON-mode via tool use or
 * instruction — see §9.1).
 */
export type ResponseFormat = 'text' | 'json_object';

/**
 * Provider-agnostic request. Each adapter translates this to a
 * wire-format payload for its proveedor.
 *
 * Contract: `maxTokens` is **mandatory** — there is no implicit
 * default because every provider ties completion cost to it and a
 * silent default would be a footgun on BYOK billing.
 *
 * @see LLM_CLIENT.md §3.3 — Shape de `LLMCallInput`
 */
export interface NormalizedLLMRequest {
  readonly model: ModelId;
  readonly messages: readonly NormalizedMessage[];
  readonly systemPrompt?: string | undefined;
  readonly maxTokens: number;
  /** Clamped to `[0, 1]` on the adapter side if necessary. */
  readonly temperature?: number | undefined;
  readonly stopSequences?: readonly string[] | undefined;
  readonly toolDefinitions?: readonly NormalizedTool[] | undefined;
  readonly responseFormat?: ResponseFormat | undefined;
}
