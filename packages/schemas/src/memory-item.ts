/**
 * Zod mirror of `schemas/memory-item.schema.json`.
 *
 * Contract anchors: UX_FROZEN.md v1.3 §5.2 + INGEST_SECURITY.md v1.0 §2, §5.
 */

import { z } from 'zod';

import {
  AV_VERDICTS_MEMORY,
  MEMORY_KINDS,
  MEMORY_SOURCES,
  SYNC_STATUSES,
  zDateTime,
  zSha256,
  zUuid,
} from './common.js';

export const memoryItemSchema = z
  .object({
    id: zUuid,
    userId: z.string(),
    source: z.enum(MEMORY_SOURCES),
    kind: z.enum(MEMORY_KINDS),
    title: z.string().min(1).max(500),
    summary: z.string().max(10_000),
    chunks: z.number().int().min(0),
    mcpExposed: z.boolean(),
    sensitive: z.boolean(),
    learnedFrom: z.array(z.string()).optional(),
    syncStatus: z.enum(SYNC_STATUSES),
    createdAt: zDateTime,
    updatedAt: zDateTime,
    lastSyncedAt: zDateTime.nullable().optional(),

    // Security block — mandatory per INGEST_SECURITY §2.
    sha256: zSha256,
    sizeBytes: z.number().int().min(0),
    mimeReal: z.string(),
    avVerdict: z.enum(AV_VERDICTS_MEMORY),
    avEngine: z.string(),
    avScannedAt: zDateTime.nullable().optional(),
    sanitized: z.boolean(),
    quotaBytesCharged: z.number().int().min(0),
  })
  .strict();

export type MemoryItem = z.infer<typeof memoryItemSchema>;
