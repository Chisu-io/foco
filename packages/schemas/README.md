# @chisu/schemas

> Canonical contract definitions for Foco. **Source of truth for the entire system.**

This package defines the six invariant data contracts that every worker, API route, and UI in Foco speaks. They come from the three anchor specs (`UX_FROZEN.md` v1.3, `INGEST_SECURITY.md` v1.0, `PRODUCTION_READINESS.md` v1.0).

## What's in here

| Contract              | JSON Schema                                 | Zod export             | Lives in spec                  |
| --------------------- | ------------------------------------------- | ---------------------- | ------------------------------ |
| `RenderRequest`       | `schemas/render-request.schema.json`        | `renderRequestSchema`  | `UX_FROZEN.md` §5.1            |
| `MemoryItem`          | `schemas/memory-item.schema.json`           | `memoryItemSchema`     | `UX_FROZEN.md` §5.2            |
| `UserQuota`           | `schemas/user-quota.schema.json`            | `userQuotaSchema`      | `UX_FROZEN.md` §5.4 + `INGEST_SECURITY.md` §4 |
| `IngestAuditEntry`    | `schemas/ingest-audit-entry.schema.json`    | `ingestAuditEntrySchema` | `UX_FROZEN.md` §5.4 + `INGEST_SECURITY.md` §4.3 |
| `SystemAuditEntry`    | `schemas/system-audit-entry.schema.json`    | `systemAuditEntrySchema` | `PRODUCTION_READINESS.md` §3   |
| `McpAuthorization`    | `schemas/mcp-authorization.schema.json`     | `mcpAuthorizationSchema` | `UX_FROZEN.md` §5.3            |

## Layers

```
schemas/*.schema.json     ← JSON Schema 2020-12 files. SSoT. Language-agnostic.
src/*.ts                  ← Hand-written zod mirrors for TypeScript consumers.
test/schemas.test.ts      ← Ajv-compiled JSON Schemas roundtrip against zod-produced samples.
                            If zod and JSON Schema drift, CI fails.
```

**Rule:** any change to a contract must land **in both** the JSON Schema and the zod mirror in the same PR. The test suite enforces they describe the same shape.

## Cross-language consumers

- **TypeScript**: `import { renderRequestSchema } from '@chisu/schemas'`
- **Python**: generate pydantic models with `datamodel-code-generator --input schemas/render-request.schema.json --output foco_schemas/render_request.py` (run in `workers/*`)
- **Docs / OpenAPI**: JSON Schemas are directly referenceable

## Changing a contract

1. Update the JSON Schema file(s) in `schemas/`
2. Update the matching zod mirror in `src/`
3. Update the relevant anchor spec and bump its version (e.g. `UX_FROZEN.md` v1.2 → v1.3) per `feedback_foco_three_contracts_rule.md`
4. Regenerate Python pydantic models in workers
5. Migrate data (database, audit log) if the change is breaking

## License

Apache-2.0. These schemas are the public interface — external integrators, OSS forks, and third-party tooling need to be able to validate and consume them freely.
