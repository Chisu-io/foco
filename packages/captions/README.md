# @chisu/captions

> SRT/ASS generation and styling from WhisperX word-level timestamps.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](../../LICENSE-APACHE-2.0)

## Status

🟡 **Pre-alpha.** API is unstable. Do not use in production yet.

## Purpose

Generates broadcast-quality subtitles from `WhisperX` word-level alignment output, with:

- **SRT emission** with configurable line-wrap strategies (by character count, by word count, by pause detection)
- **ASS emission** with explicit `PlayResX/Y` to fix libass default-resolution rendering bugs
- **Styling primitives** for short-form: high-contrast outline, bottom-anchored layout, readable sans-serif fallback stack
- **Timing refinement** using pause detection to merge or split cues for better reading pace

## Why

Naive SRT-to-video pipelines get two things wrong consistently: (1) libass silently defaults to 384×288 `PlayRes` when absent, producing tiny unreadable subtitles on 1080×1920 canvases; (2) WhisperX word timestamps need cue-building heuristics to produce readable lines.

This package solves both.

## Install

```bash
pnpm add @chisu/captions
```

## License

Apache 2.0. See [LICENSE-APACHE-2.0](../../LICENSE-APACHE-2.0) in the repository root.
