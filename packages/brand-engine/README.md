# @chisu/brand-engine

> Brand tokens, template registry, and style enforcement for Foco.

**⚠️ Proprietary — not open source.** See [LICENSE-PROPRIETARY](../../LICENSE-PROPRIETARY).

## Status

🟡 **Pre-alpha.** Internal to Chisu.

## Purpose

The brand engine is what makes a Foco video look like _your_ video, consistently, across every short. It is the core moat of the product.

Responsibilities:

- **Brand tokens**: typed representation of a brand's colors, type scale, logo variants, spacing, motion preferences, voice rules
- **Template registry**: catalog of vertical short templates, each parameterized by brand tokens
- **Style enforcement**: runtime validator that flags template usage that violates brand constraints (contrast, type sizes, logo placement)
- **Migration**: versioned brand schemas with safe migrations when brand definitions evolve

## Why proprietary

The brand engine combines domain research, legal considerations (trademark-safe logo handling), and product decisions that together form the defensible surface of Foco. It is not licensed for redistribution.

Contributions from Chisu employees are welcome via internal PRs. External contributions are not accepted.

## License

Proprietary. Copyright © 2026 Chisu. See [LICENSE-PROPRIETARY](../../LICENSE-PROPRIETARY).
