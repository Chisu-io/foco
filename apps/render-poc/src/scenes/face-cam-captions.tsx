/**
 * Face-cam + word-level captions scene for the Foco POC.
 *
 * Visual language:
 *   - Full-bleed face-cam video fills the frame.
 *   - One caption word at a time, bold, huge, near bottom (position: 'bottom'
 *     from the schema -> lower third of the frame).
 *   - The currently-spoken word is in highlightColor; fades in at tStartSec,
 *     fades out at tEndSec.
 *   - Subtle scale punch (0.95 -> 1.0) on each word for kinetic feel.
 *
 * This scene is parameterised entirely by the variables produced by
 * `src/bridge.ts`. The scene has zero knowledge of @chisu/schemas -- that
 * decoupling is intentional: if the contract changes shape, we update the
 * bridge, not every scene.
 */
import { Txt, Video, makeScene2D } from '@revideo/2d';
import { all, createRef, useScene, waitFor } from '@revideo/core';

import {
  captionPositionToYFraction,
  type RevideoProjectVariables,
} from '../bridge.js';

import type { View2D } from '@revideo/2d';

export default makeScene2D('face-cam-captions', function* (view: View2D) {
  const vars = useScene().variables.get(
    'vars',
    null as unknown as RevideoProjectVariables,
  )();

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the default value is `null as unknown as RevideoProjectVariables`; the type says always-present but runtime can legitimately hit `null` when `makeProject` forgets the variables block.
  if (!vars) {
    throw new Error(
      '[render-poc] scene variables missing -- did you forget makeProject({ variables: { vars } })?',
    );
  }

  const { resolution, durationSec, faceCam, caption } = vars;

  // --- Face-cam background -----------------------------------------------
  if (faceCam) {
    const videoRef = createRef<Video>();
    const vw = (resolution.width * faceCam.widthPct) / 100;
    const vh = (resolution.height * faceCam.heightPct) / 100;
    // transform.xPct / yPct describe the layer's center in [0, 100] over the
    // frame. Convert to Revideo's centered coordinate system ([-w/2, w/2]).
    const vx = (resolution.width * (faceCam.xPct - 50)) / 100;
    const vy = (resolution.height * (faceCam.yPct - 50)) / 100;

    view.add(
      <Video
        ref={videoRef}
        src={faceCam.sourceUri}
        width={vw}
        height={vh}
        x={vx}
        y={vy}
        rotation={faceCam.rotationDeg}
        zIndex={faceCam.zIndex}
        play={true}
      />,
    );
  }

  // --- Word-level captions -----------------------------------------------
  if (caption) {
    const captionRef = createRef<Txt>();
    const fontSizePx = (resolution.height * caption.style.fontSizePct) / 100;
    const captionY =
      resolution.height * captionPositionToYFraction(caption.style.position);

    view.add(
      <Txt
        ref={captionRef}
        text=""
        fontFamily={caption.style.fontFamily}
        fontSize={fontSizePx}
        fontWeight={800}
        fill={caption.style.color}
        stroke={caption.style.outlineColor}
        lineWidth={fontSizePx * 0.08}
        textAlign="center"
        y={captionY}
        zIndex={1000}
        opacity={0}
        scale={0.95}
      />,
    );

    // Each word: wait until tStartSec, flash in with highlight color, hold
    // until tEndSec, fade out. Sequential yields keep the caption timeline
    // driving the scene clock.
    let cursor = 0;
    for (const w of caption.words) {
      if (w.tStartSec > cursor) {
        yield* waitFor(w.tStartSec - cursor);
      }
      captionRef().text(w.word);
      captionRef().fill(caption.style.highlightColor);
      yield* all(
        captionRef().opacity(1, 0.08),
        captionRef().scale(1.0, 0.08),
      );

      const hold = Math.max(0, w.tEndSec - w.tStartSec - 0.16);
      if (hold > 0) {
        yield* waitFor(hold);
      }

      yield* all(
        captionRef().opacity(0, 0.08),
        captionRef().scale(0.95, 0.08),
      );
      cursor = w.tEndSec;
    }

    // Hold the final frame if captions ended before the video does.
    if (cursor < durationSec) {
      yield* waitFor(durationSec - cursor);
    }
  } else {
    yield* waitFor(durationSec);
  }
});
