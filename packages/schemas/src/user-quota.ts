/**
 * Zod mirror of `schemas/user-quota.schema.json`.
 *
 * Contract anchors: UX_FROZEN.md v1.3 §5.4 + INGEST_SECURITY.md v1.0 §4-§4.3
 * + project_foco_byok_model.md.
 */

import { z } from 'zod';

import {
  LLM_KEY_STATUSES,
  LLM_PROVIDERS,
  PLANS,
  zDateTime,
} from './common.js';

export const userQuotaSchema = z
  .object({
    userId: z.string(),
    plan: z.enum(PLANS),

    storageUsedBytes: z.number().int().min(0),
    storageLimitBytes: z.number().int().min(0),

    uploadsToday: z.number().int().min(0),
    uploadsDailyLimit: z.number().int().min(0),
    bytesToday: z.number().int().min(0),
    bytesDailyLimit: z.number().int().min(0),

    videosThisCycle: z.number().int().min(0),
    videosCycleLimit: z.number().int().min(0),

    seatsUsed: z.number().int().min(0),
    seatsLimit: z.number().int().min(1),

    maxUploadFileBytes: z.number().int().min(0),

    resetsAt: zDateTime,
    cycleResetsAt: zDateTime,

    // BYOK. See project_foco_byok_model.md.
    llmKeyProvider: z.enum(LLM_PROVIDERS).nullable(),
    llmKeyStatus: z.enum(LLM_KEY_STATUSES),

    // Infection escalation, INGEST_SECURITY §4.3.
    infectionEscalationStep: z.number().int().min(0).max(5),
    infectionsLast30d: z.number().int().min(0).optional(),
  })
  .strict();

export type UserQuota = z.infer<typeof userQuotaSchema>;
