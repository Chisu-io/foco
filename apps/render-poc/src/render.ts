/**
 * CLI entrypoint: render the POC fixture in 9:16 / 1:1 / 16:9.
 *
 * Output:
 *   out/
 *     foco-poc-9x16.mp4
 *     foco-poc-1x1.mp4
 *     foco-poc-16x9.mp4
 *
 * Usage (from apps/render-poc/):
 *   pnpm render                   # render all three aspect ratios
 *   pnpm render -- --aspect 9:16  # just one
 *
 * Notes:
 *   - This needs a browser (Revideo spawns Puppeteer under the hood).
 *   - On macOS/Linux/Windows desktops it should Just Work after
 *     `pnpm install && pnpm approve-builds` (Puppeteer needs its postinstall
 *     to run so Chrome is downloaded). The sandbox CI does not have Chrome,
 *     so CI runs the non-render bridge tests in `pnpm test` instead.
 */
import { mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderVideo } from '@revideo/renderer';

import { SUPPORTED_ASPECTS } from './aspect.js';
import {
  toProjectVariablesForAspects,
  type RevideoProjectVariables,
} from './bridge.js';
import { faceCamCaptionsFixture } from './fixture.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const outDir = resolve(__dirname, '../out');
const projectFile = resolve(__dirname, 'project.ts');

function parseArgs(): { aspects: readonly (typeof SUPPORTED_ASPECTS)[number][] } {
  const idx = process.argv.indexOf('--aspect');
  if (idx === -1) return { aspects: SUPPORTED_ASPECTS };
  const requested = process.argv[idx + 1];
  const match = SUPPORTED_ASPECTS.find((a) => a === requested);
  if (!match) {
    throw new Error(
      `[render-poc] unknown --aspect '${requested ?? ''}'. Supported: ${SUPPORTED_ASPECTS.join(', ')}`,
    );
  }
  return { aspects: [match] };
}

function filenameFor(vars: RevideoProjectVariables): `${string}.mp4` {
  const slug = vars.aspectRatio.replace(':', 'x');
  return `foco-poc-${slug}.mp4`;
}

async function main(): Promise<void> {
  mkdirSync(outDir, { recursive: true });

  const { aspects } = parseArgs();
  const variablesPerAspect = toProjectVariablesForAspects(
    faceCamCaptionsFixture,
    aspects,
  );

  console.log(
    `[render-poc] fixture=${faceCamCaptionsFixture.id} aspects=${aspects.join(',')}`,
  );

  for (const vars of variablesPerAspect) {
    const outFile = filenameFor(vars);
    const outPath = resolve(outDir, outFile);
    console.log(
      `[render-poc] rendering ${vars.aspectRatio} ` +
        `(${String(vars.resolution.width)}x${String(vars.resolution.height)} @ ${String(vars.fps)}fps, ` +
        `${String(vars.durationSec)}s) -> ${outPath}`,
    );
    await renderVideo({
      projectFile,
      variables: { vars },
      settings: {
        outDir,
        outFile,
        logProgress: true,
        projectSettings: {
          size: {
            x: vars.resolution.width,
            y: vars.resolution.height,
          },
        },
      },
    });
    console.log(`[render-poc] done: ${outPath}`);
  }

  console.log('[render-poc] all renders complete.');
}

main().catch((err: unknown) => {
  console.error('[render-poc] FAILED:', err);
  process.exit(1);
});
