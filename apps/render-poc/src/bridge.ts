/**
 * Bridge: RenderRequest (contract) → RevideoProjectVariables (renderer input).
 *
 * This is the only code that knows how to translate a validated
 * @chisu/schemas.RenderRequest into the shape the Revideo scene expects.
 * Keeping it separate means:
 *   - The scene file stays declarative and trivial.
 *   - The contract can evolve without touching the scene, or vice versa.
 *   - It is fully pure, so we can unit-test it without a headless browser.
 *
 * Scope for the POC: we only support single-scene RenderRequests with one
 * optional faceCam layer and one optional caption layer. Additional layer
 * kinds (avatar, overlay, bgMusic) are contract-valid but out of scope for
 * this first video. Attempting to render them here throws a clear error.
 */
import { resolutionFor, type Resolution } from './aspect.js';

import type {
  CaptionWord,
  Layer,
  RenderRequest,
  Scene,
} from '@chisu/schemas';

/**
 * Flat, renderer-friendly view of the caption style. Defaults are applied
 * here so the scene never has to branch on `undefined`.
 */
export interface CaptionStyleVars {
  readonly fontFamily: string;
  readonly fontSizePct: number;
  readonly color: string;
  readonly outlineColor: string;
  readonly highlightColor: string;
  readonly position: 'top' | 'center' | 'bottom';
}

export interface FaceCamVars {
  readonly sourceUri: string;
  readonly xPct: number;
  readonly yPct: number;
  readonly widthPct: number;
  readonly heightPct: number;
  readonly rotationDeg: number;
  readonly zIndex: number;
}

export interface CaptionVars {
  readonly words: readonly CaptionWord[];
  readonly style: CaptionStyleVars;
}

export interface RevideoProjectVariables {
  readonly requestId: string;
  readonly userId: string;
  readonly aspectRatio: RenderRequest['aspectRatio'];
  readonly durationSec: number;
  readonly fps: number;
  readonly resolution: Resolution;
  readonly faceCam: FaceCamVars | null;
  readonly caption: CaptionVars | null;
}

// --- Defaults (mirror zod .default() values in @chisu/schemas) ------------

const CAPTION_STYLE_DEFAULTS: CaptionStyleVars = {
  fontFamily: 'Inter',
  fontSizePct: 6,
  color: '#FFFFFF',
  outlineColor: '#000000',
  highlightColor: '#FFD60A',
  position: 'bottom',
};

const TRANSFORM_DEFAULTS = {
  xPct: 50,
  yPct: 50,
  widthPct: 100,
  heightPct: 100,
  rotationDeg: 0,
  zIndex: 0,
} as const;

// --- Helpers ---------------------------------------------------------------

function requireSingleScene(request: RenderRequest): Scene {
  if (request.scenes.length !== 1) {
    throw new Error(
      `[render-poc] POC only supports single-scene requests; got ${String(request.scenes.length)}`,
    );
  }
  const scene = request.scenes[0];
  if (!scene) {
    throw new Error('[render-poc] scenes[0] missing (schema contract broken)');
  }
  return scene;
}

function findFirst<K extends Layer['kind']>(
  layers: readonly Layer[],
  kind: K,
): Extract<Layer, { kind: K }> | undefined {
  return layers.find((l): l is Extract<Layer, { kind: K }> => l.kind === kind);
}

function ensureKnownLayerKinds(layers: readonly Layer[]): void {
  const supported = new Set<Layer['kind']>(['faceCam', 'caption']);
  for (const layer of layers) {
    if (!supported.has(layer.kind)) {
      throw new Error(
        `[render-poc] layer kind '${layer.kind}' is contract-valid but not implemented in the POC scene. ` +
          `Add rendering in src/scenes/face-cam-captions.tsx first.`,
      );
    }
  }
}

function mapFaceCam(
  layer: Extract<Layer, { kind: 'faceCam' }>,
): FaceCamVars {
  // `layer.transform` is the schema-defined transform (all fields required
  // after zod defaults apply); when absent, we fall back to TRANSFORM_DEFAULTS
  // which is a typed const literal. Either way, the 6 fields below are
  // non-nullable at this point — the per-field `??` was redundant.
  const t = layer.transform ?? TRANSFORM_DEFAULTS;
  return {
    sourceUri: layer.sourceUri,
    xPct: t.xPct,
    yPct: t.yPct,
    widthPct: t.widthPct,
    heightPct: t.heightPct,
    rotationDeg: t.rotationDeg,
    zIndex: t.zIndex,
  };
}

function mapCaption(
  layer: Extract<Layer, { kind: 'caption' }>,
): CaptionVars {
  const s = layer.style;
  return {
    words: layer.words,
    style: {
      fontFamily: s?.fontFamily ?? CAPTION_STYLE_DEFAULTS.fontFamily,
      fontSizePct: s?.fontSizePct ?? CAPTION_STYLE_DEFAULTS.fontSizePct,
      color: s?.color ?? CAPTION_STYLE_DEFAULTS.color,
      outlineColor: s?.outlineColor ?? CAPTION_STYLE_DEFAULTS.outlineColor,
      highlightColor: s?.highlightColor ?? CAPTION_STYLE_DEFAULTS.highlightColor,
      position: s?.position ?? CAPTION_STYLE_DEFAULTS.position,
    },
  };
}

// --- Public API ------------------------------------------------------------

/**
 * Translate a validated RenderRequest into the flat variable bag the
 * Revideo scene consumes. Throws if the request violates the POC's layer
 * assumptions (unsupported kinds, multi-scene, etc.).
 */
export function toProjectVariables(
  request: RenderRequest,
): RevideoProjectVariables {
  const scene = requireSingleScene(request);
  ensureKnownLayerKinds(scene.layers);

  const faceCamLayer = findFirst(scene.layers, 'faceCam');
  const captionLayer = findFirst(scene.layers, 'caption');

  return {
    requestId: request.id,
    userId: request.userId,
    aspectRatio: request.aspectRatio,
    durationSec: request.durationSec,
    fps: request.fps,
    resolution: resolutionFor(request.aspectRatio),
    faceCam: faceCamLayer ? mapFaceCam(faceCamLayer) : null,
    caption: captionLayer ? mapCaption(captionLayer) : null,
  };
}

/**
 * Produce one variables bag per aspect ratio requested. Used by the POC
 * runner to render the same RenderRequest in 9:16 / 1:1 / 16:9 without
 * forcing the caller to mutate the fixture.
 */
export function toProjectVariablesForAspects(
  request: RenderRequest,
  aspects: readonly RenderRequest['aspectRatio'][],
): RevideoProjectVariables[] {
  return aspects.map((aspect) =>
    toProjectVariables({ ...request, aspectRatio: aspect }),
  );
}

/**
 * Convert the schema's semantic caption position to a normalised vertical
 * offset (as a fraction of frame height from center). Kept separate from
 * `mapCaption` so scenes that want absolute positioning can opt in.
 *
 *   'top'    → -0.35   (upper third)
 *   'center' →  0.0
 *   'bottom' →  0.35   (lower third, safe-area aware)
 */
export function captionPositionToYFraction(
  position: CaptionStyleVars['position'],
): number {
  switch (position) {
    case 'top':
      return -0.35;
    case 'center':
      return 0;
    case 'bottom':
      return 0.35;
  }
}
