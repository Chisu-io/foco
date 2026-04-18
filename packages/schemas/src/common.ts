/**
 * Shared enum tuples + primitive zod helpers.
 *
 * Single-writer rule: whenever you change one of these tuples, you MUST update
 * the matching JSON Schema `enum` array in `schemas/*.schema.json`. CI runs
 * `test/schemas.test.ts` which cross-validates both shapes.
 */

import { z } from 'zod';

// --- Enum tuples ------------------------------------------------------------

/** 11 MVP sources of Memoria. UX_FROZEN §3.1. */
export const MEMORY_SOURCES = [
  'file',
  'link',
  'drive',
  'github',
  'mcp',
  'youtube',
  'tiktok',
  'facebook',
  'linkedin',
  'instagram',
  'x',
] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

/** Kinds of memory a chunk can belong to. UX_FROZEN §5.2. */
export const MEMORY_KINDS = [
  'document',
  'link',
  'video',
  'post',
  'note',
  'conversation',
  'learning',
  'website-section',
] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/** Signed plan tiers. INGEST_SECURITY §4 (2026-04-17). */
export const PLANS = [
  'free',
  'creator',
  'influencer',
  'celebrity',
  'studio',
] as const;
export type Plan = (typeof PLANS)[number];

/** Sync status of a MemoryItem. UX_FROZEN §5.2. */
export const SYNC_STATUSES = ['live', 'paused', 'error', 'manual'] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

/** AV scan verdict for a MemoryItem or IngestAuditEntry. */
export const AV_VERDICTS_MEMORY = [
  'clean',
  'infected',
  'unknown',
  'not-applicable',
] as const;
export type MemoryAvVerdict = (typeof AV_VERDICTS_MEMORY)[number];

export const AV_VERDICTS_AUDIT = [
  'clean',
  'infected',
  'unknown',
  'skipped-not-applicable',
  'error',
] as const;
export type IngestAvVerdict = (typeof AV_VERDICTS_AUDIT)[number];

/** Final disposition of an ingest attempt. */
export const INGEST_VERDICTS = [
  'accepted',
  'rejected',
  'quarantined',
  'error',
] as const;
export type IngestVerdict = (typeof INGEST_VERDICTS)[number];

/** Aspect ratios supported in MVP. UX_FROZEN §3.4. */
export const ASPECT_RATIOS = ['9:16', '1:1', '16:9'] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

/** MCP scopes. UX_FROZEN §3.2. */
export const MCP_SCOPES = [
  'learnings',
  'brand',
  'documents',
  'github',
  'socials',
] as const;
export type McpScope = (typeof MCP_SCOPES)[number];

/** LLM BYOK providers. */
export const LLM_PROVIDERS = ['anthropic', 'openai'] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

/** LLM BYOK key status. */
export const LLM_KEY_STATUSES = [
  'active',
  'invalid',
  'quota_exhausted',
  'not_set',
] as const;
export type LlmKeyStatus = (typeof LLM_KEY_STATUSES)[number];

/** Kinds of actor that can emit a SystemAuditEntry. */
export const SYSTEM_ACTOR_KINDS = [
  'user',
  'service',
  'system',
  'mcp-agent',
  'admin',
] as const;
export type SystemActorKind = (typeof SYSTEM_ACTOR_KINDS)[number];

// --- Primitive zod helpers --------------------------------------------------

/** ISO-8601 UTC datetime string. */
export const zDateTime = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/,
    'must be an ISO-8601 UTC datetime',
  );

/** Lowercase hex SHA-256 digest (64 chars). */
export const zSha256 = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'must be a lowercase hex SHA-256 digest (64 chars)');

/** Hex color: #RRGGBB or #RRGGBBAA. */
export const zHexColor = z
  .string()
  .regex(
    /^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/,
    'must be a #RRGGBB or #RRGGBBAA hex color',
  );

/** UUID. Accepts any version. */
export const zUuid = z.string().uuid();

/** URL. */
export const zUrl = z.string().url();
