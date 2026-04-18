/**
 * Revideo project entrypoint for the Foco render POC.
 *
 * This file is the `projectFile` handed to `renderVideo()`. It must:
 *   1. Be loadable by Vite / Puppeteer (no `node:*` imports at module scope).
 *   2. `export default makeProject(...)` so the Revideo renderer can discover
 *      scenes, default variables and default settings.
 *
 * Per-render overrides (actual aspect-ratio size, per-fixture `vars`, output
 * path) live in `src/render.ts` and flow through `renderVideo()` arguments.
 * Everything in this file is a sensible default that keeps the project
 * previewable on its own (e.g. for `revideo studio`-style inspection later).
 */
import { makeProject } from '@revideo/core';

import { toProjectVariables } from './bridge.js';
import { faceCamCaptionsFixture } from './fixture.js';
import scene from './scenes/face-cam-captions.js';

const defaultVars = toProjectVariables(faceCamCaptionsFixture);

export default makeProject({
  name: 'foco-render-poc',
  scenes: [scene],
  variables: { vars: defaultVars },
  settings: {
    shared: {
      size: {
        x: defaultVars.resolution.width,
        y: defaultVars.resolution.height,
      },
    },
    rendering: {
      fps: defaultVars.fps,
    },
  },
});
