/**
 * Zod mirror of `schemas/render-request.schema.json`.
 *
 * Contract anchor: UX_FROZEN.md v1.3 §5.1.
 *
 * Any structural change must land in both files in the same commit and bump
 * UX_FROZEN.md (feedback_foco_three_contracts_rule.md).
 */

import { z } from 'zod';

import { ASPECT_RATIOS, zDateTime, zHexColor, zUrl, zUuid } from './common.js';

// --- Helpers ----------------------------------------------------------------

export const trimSchema = z
  .object({
    inSec: z.number().min(0).optional(),
    outSec: z.number().positive().optional(),
  })
  .strict();

export const transformSchema = z
  .object({
    xPct: z.number().min(-100).max(200).default(50),
    yPct: z.number().min(-100).max(200).default(50),
    widthPct: z.number().positive().max(200).default(100),
    heightPct: z.number().positive().max(200).default(100),
    rotationDeg: z.number().min(-360).max(360).default(0),
    zIndex: z.number().int().default(0),
  })
  .strict();

export const captionStyleSchema = z
  .object({
    fontFamily: z.string().default('Inter'),
    fontSizePct: z.number().min(2).max(20).default(6),
    color: zHexColor.default('#FFFFFF'),
    outlineColor: zHexColor.default('#000000'),
    highlightColor: zHexColor.optional(),
    position: z.enum(['top', 'center', 'bottom']).default('bottom'),
  })
  .strict();

export const captionWordSchema = z
  .object({
    word: z.string().min(1),
    tStartSec: z.number().min(0),
    tEndSec: z.number().positive(),
  })
  .strict();

// --- Layers ----------------------------------------------------------------

export const faceCamLayerSchema = z
  .object({
    kind: z.literal('faceCam'),
    id: z.string(),
    sourceUri: zUrl,
    trim: trimSchema.optional(),
    transform: transformSchema.optional(),
  })
  .strict();

export const avatarLayerSchema = z
  .object({
    kind: z.literal('avatar'),
    id: z.string(),
    avatarId: z.string(),
    script: z.string(),
    emotion: z
      .enum(['neutral', 'enthusiastic', 'calm', 'serious'])
      .default('neutral'),
    transform: transformSchema.optional(),
  })
  .strict();

export const captionLayerSchema = z
  .object({
    kind: z.literal('caption'),
    id: z.string(),
    words: z.array(captionWordSchema).min(1),
    style: captionStyleSchema.optional(),
  })
  .strict();

export const textOverlaySchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
    style: captionStyleSchema.optional(),
  })
  .strict();

export const imageOverlaySchema = z
  .object({
    type: z.literal('image'),
    sourceUri: zUrl,
    opacity: z.number().min(0).max(1).default(1),
  })
  .strict();

export const shapeOverlaySchema = z
  .object({
    type: z.literal('shape'),
    shape: z.enum(['rect', 'circle', 'rounded-rect']),
    fill: zHexColor.optional(),
  })
  .strict();

export const overlayContentSchema = z.discriminatedUnion('type', [
  textOverlaySchema,
  imageOverlaySchema,
  shapeOverlaySchema,
]);

export const overlayLayerSchema = z
  .object({
    kind: z.literal('overlay'),
    id: z.string(),
    content: overlayContentSchema,
    startSec: z.number().min(0).optional(),
    endSec: z.number().positive().optional(),
    transform: transformSchema.optional(),
  })
  .strict();

export const bgMusicLayerSchema = z
  .object({
    kind: z.literal('bgMusic'),
    id: z.string(),
    sourceUri: zUrl,
    volumeDb: z.number().min(-60).max(0).default(-18),
    fadeInSec: z.number().min(0).default(0),
    fadeOutSec: z.number().min(0).default(0),
  })
  .strict();

export const layerSchema = z.discriminatedUnion('kind', [
  faceCamLayerSchema,
  avatarLayerSchema,
  captionLayerSchema,
  overlayLayerSchema,
  bgMusicLayerSchema,
]);

// --- Scene + output + brand ------------------------------------------------

export const sceneSchema = z
  .object({
    id: z.string(),
    startSec: z.number().min(0),
    endSec: z.number().positive(),
    cacheKey: z.string().optional(),
    layers: z.array(layerSchema).min(1),
  })
  .strict();

export const outputSpecSchema = z
  .object({
    container: z.enum(['mp4', 'mov', 'webm']).default('mp4'),
    videoCodec: z.enum(['h264', 'h265', 'av1', 'vp9']).default('h264'),
    audioCodec: z.enum(['aac', 'opus']).default('aac'),
    videoBitrateKbps: z.number().int().min(500).max(20_000).default(6000),
    audioBitrateKbps: z.number().int().min(64).max(320).default(192),
  })
  .strict();

export const brandTokensSchema = z
  .object({
    primaryColor: zHexColor.optional(),
    accentColor: zHexColor.optional(),
    fontFamily: z.string().optional(),
    logoUri: zUrl.optional(),
  })
  .strict();

// --- RenderRequest ---------------------------------------------------------

export const renderRequestSchema = z
  .object({
    id: zUuid,
    userId: z.string(),
    aspectRatio: z.enum(ASPECT_RATIOS),
    durationSec: z.number().positive().max(600),
    fps: z
      .union([z.literal(24), z.literal(30), z.literal(60)])
      .describe('Output frame rate'),
    scenes: z.array(sceneSchema).min(1),
    output: outputSpecSchema,
    brand: brandTokensSchema.optional(),
    createdAt: zDateTime,
  })
  .strict();

export type RenderRequest = z.infer<typeof renderRequestSchema>;
export type Scene = z.infer<typeof sceneSchema>;
export type Layer = z.infer<typeof layerSchema>;
export type CaptionWord = z.infer<typeof captionWordSchema>;
export type OutputSpec = z.infer<typeof outputSpecSchema>;
export type BrandTokens = z.infer<typeof brandTokensSchema>;
