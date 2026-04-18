/**
 * @chisu/schemas — canonical contracts for Foco.
 *
 * See README.md and the three anchor specs:
 *   - UX_FROZEN.md v1.3
 *   - INGEST_SECURITY.md v1.0
 *   - PRODUCTION_READINESS.md v1.0
 *
 * Rule: a change to any contract lands in the JSON Schema, the zod mirror, and
 * the relevant anchor spec in the same PR. CI validates all three are in sync.
 *
 * @packageDocumentation
 */

export const VERSION = '0.0.0' as const;

// Shared enums + primitive helpers
export * from './common.js';

// Contract schemas — zod
export * from './render-request.js';
export * from './memory-item.js';
export * from './user-quota.js';
export * from './ingest-audit-entry.js';
export * from './system-audit-entry.js';
export * from './mcp-authorization.js';

// Canonical JSON Schema 2020-12 documents (SSoT)
export * from './json.js';
