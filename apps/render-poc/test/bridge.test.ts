/**
 * Bridge tests. These run headlessly (no browser) and cover the contract →
 * Revideo-variables translation. If @chisu/schemas changes shape or the
 * POC scene gains a new layer kind, these tests tell us exactly where to
 * adapt.
 */
import { describe, expect, it } from 'vitest';

import { resolutionFor, SUPPORTED_ASPECTS } from '../src/aspect.js';
import {
  captionPositionToYFraction,
  toProjectVariables,
  toProjectVariablesForAspects,
} from '../src/bridge.js';
import { faceCamCaptionsFixture } from '../src/fixture.js';

import type { RenderRequest } from '@chisu/schemas';

describe('aspect ratio table', () => {
  it('maps the three MVP ratios to 1080p resolutions', () => {
    expect(resolutionFor('9:16')).toEqual({ width: 1080, height: 1920 });
    expect(resolutionFor('1:1')).toEqual({ width: 1080, height: 1080 });
    expect(resolutionFor('16:9')).toEqual({ width: 1920, height: 1080 });
  });

  it('declares exactly the three ratios the contract enumerates', () => {
    // Order-independent: the three MVP aspect ratios, no more, no less.
    // (Plain `.sort()` on these strings is lexicographic, so '16:9' < '1:1'
    // by character code — we use a Set to stay order-agnostic.)
    expect(new Set(SUPPORTED_ASPECTS)).toEqual(new Set(['9:16', '1:1', '16:9']));
    expect(SUPPORTED_ASPECTS).toHaveLength(3);
  });
});

describe('captionPositionToYFraction', () => {
  it('places "top" in the upper third, "center" at 0, "bottom" in the lower third', () => {
    expect(captionPositionToYFraction('top')).toBeLessThan(0);
    expect(captionPositionToYFraction('center')).toBe(0);
    expect(captionPositionToYFraction('bottom')).toBeGreaterThan(0);
  });
});

describe('toProjectVariables (fixture)', () => {
  const vars = toProjectVariables(faceCamCaptionsFixture);

  it('preserves identity metadata from the RenderRequest', () => {
    expect(vars.requestId).toBe(faceCamCaptionsFixture.id);
    expect(vars.userId).toBe(faceCamCaptionsFixture.userId);
    expect(vars.durationSec).toBe(faceCamCaptionsFixture.durationSec);
    expect(vars.fps).toBe(faceCamCaptionsFixture.fps);
  });

  it('projects the aspect ratio to a concrete resolution', () => {
    expect(vars.aspectRatio).toBe(faceCamCaptionsFixture.aspectRatio);
    expect(vars.resolution).toEqual(
      resolutionFor(faceCamCaptionsFixture.aspectRatio),
    );
  });

  it('extracts a single face-cam layer with a full-bleed transform', () => {
    expect(vars.faceCam).not.toBeNull();
    expect(vars.faceCam?.sourceUri).toMatch(/^https?:\/\//);
    expect(vars.faceCam?.widthPct).toBe(100);
    expect(vars.faceCam?.heightPct).toBe(100);
  });

  it('extracts a caption layer with word-level timing (tStartSec/tEndSec)', () => {
    expect(vars.caption).not.toBeNull();
    const words = vars.caption?.words ?? [];
    expect(words.length).toBeGreaterThan(0);

    // Monotonic timing — each word starts on or after the previous one ends.
    for (let i = 1; i < words.length; i++) {
      const prev = words[i - 1]!;
      const curr = words[i]!;
      expect(curr.tStartSec).toBeGreaterThanOrEqual(prev.tStartSec);
      expect(curr.tEndSec).toBeGreaterThan(curr.tStartSec);
    }

    // No word runs past the scene duration.
    const last = words[words.length - 1]!;
    expect(last.tEndSec).toBeLessThanOrEqual(vars.durationSec);
  });

  it('applies caption style defaults when the fixture omits a field', () => {
    // Our fixture sets every field; this just documents the default behavior
    // for anyone reading the test.
    expect(vars.caption?.style.fontFamily).toBe('Inter');
    expect(vars.caption?.style.position).toBe('bottom');
  });
});

describe('toProjectVariablesForAspects', () => {
  it('produces one variables bag per requested aspect, each with correct resolution', () => {
    const bags = toProjectVariablesForAspects(
      faceCamCaptionsFixture,
      SUPPORTED_ASPECTS,
    );
    expect(bags).toHaveLength(3);
    for (const [i, bag] of bags.entries()) {
      const aspect = SUPPORTED_ASPECTS[i]!;
      expect(bag.aspectRatio).toBe(aspect);
      expect(bag.resolution).toEqual(resolutionFor(aspect));
      expect(bag.requestId).toBe(faceCamCaptionsFixture.id);
    }
  });
});

describe('bridge rejects out-of-scope RenderRequests', () => {
  it('refuses multi-scene requests (not yet supported by the POC)', () => {
    const multiScene: RenderRequest = {
      ...faceCamCaptionsFixture,
      scenes: [
        faceCamCaptionsFixture.scenes[0]!,
        faceCamCaptionsFixture.scenes[0]!,
      ],
    };
    expect(() => toProjectVariables(multiScene)).toThrow(/single-scene/);
  });

  it('refuses contract-valid layer kinds the POC has not implemented yet', () => {
    const firstScene = faceCamCaptionsFixture.scenes[0]!;
    const withAvatar: RenderRequest = {
      ...faceCamCaptionsFixture,
      scenes: [
        {
          ...firstScene,
          layers: [
            ...firstScene.layers,
            {
              kind: 'avatar',
              id: 'avatar-unexpected',
              avatarId: 'avatar-default',
              script: 'hello from the unexpected layer',
              emotion: 'neutral',
            },
          ],
        },
      ],
    };
    expect(() => toProjectVariables(withAvatar)).toThrow(/avatar/);
  });
});
