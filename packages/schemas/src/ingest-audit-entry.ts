/**
 * Zod mirror of `schemas/ingest-audit-entry.schema.json`.
 *
 * Contract anchors: UX_FROZEN.md v1.3 §5.4 + INGEST_SECURITY.md v1.0 §2.
 *
 * Written BEFORE accepting the upload. If the write fails, the upload fails
 * (fail-closed). See INGEST_SECURITY §2 invariant 10.
 */

import { z } from 'zod';

import {
  AV_VERDICTS_AUDIT,
  INGEST_VERDICTS,
  MEMORY_SOURCES,
  zDateTime,
  zSha256,
  zUrl,
  zUuid,
} from './common.js';

export const ingestAuditEntrySchema = z
  .object({
    id: zUuid,
    userId: z.string(),
    source: z.enum(MEMORY_SOURCES),

    filename: z.string().max(255).nullable(),
    sizeBytes: z.number().int().min(0).nullable(),
    mimeDeclared: z.string().nullable(),
    mimeReal: z.string().nullable(),
    sha256: zSha256.nullable(),

    avVerdict: z.enum(AV_VERDICTS_AUDIT),
    avEngine: z.string().nullable(),
    avEngineVersion: z.string().nullable().optional(),
    scanDurationMs: z.number().int().min(0).nullable(),

    verdict: z.enum(INGEST_VERDICTS),
    reason: z.string().nullable(),

    quarantineUri: zUrl.nullable().optional(),

    timestamp: zDateTime,
  })
  .strict();

export type IngestAuditEntry = z.infer<typeof ingestAuditEntrySchema>;
