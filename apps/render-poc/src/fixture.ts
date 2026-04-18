/**
 * Canonical face-cam + captions fixture, validated against @chisu/schemas.
 *
 * The fixture is imported statically (not read via fs) so the same module
 * works under Node (CLI / Vitest) and under Vite/Puppeteer (Revideo renderer).
 * If the fixture ever drifts from the contract, zod throws at import-time,
 * which means CI / the renderer fails fast with a readable error instead of
 * a silent mis-render.
 */
import { renderRequestSchema, type RenderRequest } from '@chisu/schemas';

// Vite, tsx, and Node (>=20.10) all honour `resolveJsonModule` — no fs access.
import fixtureJson from '../fixtures/face-cam-captions.json';

// zod throws ZodError on mismatch — we let it bubble so the CLI surfaces it.
export const faceCamCaptionsFixture: RenderRequest =
  renderRequestSchema.parse(fixtureJson);
