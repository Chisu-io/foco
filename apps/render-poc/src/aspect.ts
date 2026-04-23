/**
 * Aspect-ratio → resolution table for Foco MVP (1080p track).
 *
 * UX_FROZEN v1.3 §5.1: aspect ratio is `9:16 | 1:1 | 16:9`.
 * This module is the only place that maps abstract ratios to concrete
 * (width, height) pixel dimensions. The renderer and schema layer never
 * hard-code pixels.
 */
import type { RenderRequest } from '@chisu/schemas';

type AspectRatio = RenderRequest['aspectRatio'];

export interface Resolution {
  readonly width: number;
  readonly height: number;
}

/**
 * 1080p MVP table. Phase 2 will introduce 4K (2160p track).
 *
 * - 9:16 → 1080 × 1920 (TikTok / Reels / Shorts)
 * - 1:1  → 1080 × 1080 (legacy IG feed)
 * - 16:9 → 1920 × 1080 (YouTube landscape)
 */
const RESOLUTION_BY_ASPECT: Readonly<Record<AspectRatio, Resolution>> = {
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '16:9': { width: 1920, height: 1080 },
};

export function resolutionFor(aspect: AspectRatio): Resolution {
  const res = RESOLUTION_BY_ASPECT[aspect];
  // This is unreachable given the schema's enum, but we keep the guard so
  // future ratio additions cause a compile error here instead of silent
  // failure in the renderer.
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive guard against runtime shapes that bypass the schema (e.g. legacy payloads pre-UX_FROZEN v1.3).
  if (!res) {
    throw new Error(`[render-poc] unknown aspect ratio: ${aspect}`);
  }
  return res;
}

export const SUPPORTED_ASPECTS: readonly AspectRatio[] = [
  '9:16',
  '1:1',
  '16:9',
];
