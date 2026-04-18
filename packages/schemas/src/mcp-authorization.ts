/**
 * Zod mirror of `schemas/mcp-authorization.schema.json`.
 *
 * Contract anchors: UX_FROZEN.md v1.3 §5.3 + §3.2 + project_foco_mcp_bidireccional.md.
 *
 * Per-agent scoped authorization for external AIs that call Foco as an MCP
 * server. Conservative defaults. Foco's internal assistant conversations are
 * NEVER re-exposed via MCP — enforced at the query layer, not this schema.
 */

import { z } from 'zod';

import { MCP_SCOPES, zDateTime, zSha256, zUuid } from './common.js';

export const mcpRateLimitSchema = z
  .object({
    callsPerMinute: z.number().int().min(1).default(60),
    callsPerDay: z.number().int().min(1).default(5_000),
  })
  .strict();

export const mcpAuthorizationSchema = z
  .object({
    id: zUuid,
    userId: z.string(),
    agentId: z.string(),
    displayName: z.string().min(1).max(120),
    apiKeyHash: zSha256,
    apiKeyPreview: z.string().nullable().optional(),
    scopes: z.array(z.enum(MCP_SCOPES)).min(1),
    createdAt: zDateTime,
    lastUsedAt: zDateTime.nullable().optional(),
    revokedAt: zDateTime.nullable().optional(),
    rateLimit: mcpRateLimitSchema.optional(),
  })
  .strict();

export type McpAuthorization = z.infer<typeof mcpAuthorizationSchema>;
