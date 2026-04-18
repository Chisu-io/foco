/**
 * Runtime-loadable JSON Schema 2020-12 documents.
 *
 * These are the **canonical** shape of every contract — zod mirrors in the
 * sibling files are derived hand-in-hand but the JSON is SSoT, in line with
 * UX_FROZEN.md v1.3 §6 step 1.
 *
 * The files are statically imported so consumers can feed them straight to
 * Ajv, OpenAPI builders, or datamodel-code-generator without a filesystem
 * roundtrip.
 */

import renderRequest from '../schemas/render-request.schema.json' with { type: 'json' };
import memoryItem from '../schemas/memory-item.schema.json' with { type: 'json' };
import userQuota from '../schemas/user-quota.schema.json' with { type: 'json' };
import ingestAuditEntry from '../schemas/ingest-audit-entry.schema.json' with { type: 'json' };
import systemAuditEntry from '../schemas/system-audit-entry.schema.json' with { type: 'json' };
import mcpAuthorization from '../schemas/mcp-authorization.schema.json' with { type: 'json' };

export const renderRequestJsonSchema = renderRequest;
export const memoryItemJsonSchema = memoryItem;
export const userQuotaJsonSchema = userQuota;
export const ingestAuditEntryJsonSchema = ingestAuditEntry;
export const systemAuditEntryJsonSchema = systemAuditEntry;
export const mcpAuthorizationJsonSchema = mcpAuthorization;

export const jsonSchemas = {
  RenderRequest: renderRequestJsonSchema,
  MemoryItem: memoryItemJsonSchema,
  UserQuota: userQuotaJsonSchema,
  IngestAuditEntry: ingestAuditEntryJsonSchema,
  SystemAuditEntry: systemAuditEntryJsonSchema,
  McpAuthorization: mcpAuthorizationJsonSchema,
} as const;

export type ContractName = keyof typeof jsonSchemas;
