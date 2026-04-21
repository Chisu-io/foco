/**
 * Barrel for normalized request + response shapes that are visible
 * at the `@chisu/llm-client/types` subpath.
 *
 * Kept separate from the root `types.ts` (which holds `Result` + `ok`
 * + `err`) so imports can be narrowed to just the shapes without
 * dragging the result primitives along.
 */

export type {
  ModelId,
  NormalizedContentBlock,
  NormalizedLLMRequest,
  NormalizedMessage,
  NormalizedTool,
  ResponseFormat,
} from './request.js';

export type {
  LLMCallOutput,
  PingOutput,
  ProviderCallOutput,
  StopReason,
  UsageCounts,
} from './response.js';

export type { ConsentMode, UserLLMKeyRepo } from './repos.js';
