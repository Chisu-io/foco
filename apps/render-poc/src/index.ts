/**
 * Public exports of the render POC. The CLI lives in `render.ts`; this
 * module exposes the bridge and aspect helpers so other packages (future
 * `render-worker`) can reuse the RenderRequest → Revideo translation.
 */
export {
  resolutionFor,
  SUPPORTED_ASPECTS,
  type Resolution,
} from './aspect.js';

export {
  toProjectVariables,
  toProjectVariablesForAspects,
  type CaptionStyleVars,
  type CaptionVars,
  type FaceCamVars,
  type RevideoProjectVariables,
} from './bridge.js';

export { faceCamCaptionsFixture } from './fixture.js';
