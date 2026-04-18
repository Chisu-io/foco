/**
 * Zod mirror of `schemas/system-audit-entry.schema.json`.
 *
 * Contract anchor: PRODUCTION_READINESS.md v1.0 §3.
 *
 * Tamper-evident: each row carries `prevHash` = SHA-256 of the previous
 * row's canonical JSON. A monthly dump to R2 Object Lock is cosign-signed
 * (7-year retention). Verification job runs nightly and pages on mismatch.
 */

import { z } from 'zod';

import { SYSTEM_ACTOR_KINDS, zDateTime, zSha256, zUuid } from './common.js';

export const actorSchema = z
  .object({
    kind: z.enum(SYSTEM_ACTOR_KINDS),
    id: z.string().nullable().optional(),
    displayName: z.string().nullable().optional(),
  })
  .strict();

export const systemAuditResourceSchema = z
  .object({
    type: z.string(),
    id: z.string(),
  })
  .strict();

export const systemAuditEntrySchema = z
  .object({
    id: zUuid,
    sequence: z.number().int().min(0),
    occurredAt: zDateTime,

    actor: actorSchema,
    action: z
      .string()
      .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/, 'dotted.namespaced.action'),

    resource: systemAuditResourceSchema.nullable().optional(),
    details: z.record(z.unknown()).nullable().optional(),

    requestId: z.string().nullable().optional(),
    ip: z.string().nullable().optional(),
    userAgent: z.string().nullable().optional(),

    prevHash: zSha256,
    rowHash: zSha256,
  })
  .strict();

export type SystemAuditEntry = z.infer<typeof systemAuditEntrySchema>;
export type SystemActor = z.infer<typeof actorSchema>;
