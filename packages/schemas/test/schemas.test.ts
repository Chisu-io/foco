/**
 * Cross-validation test. For each of the six contracts:
 *
 * 1. Compile the JSON Schema with Ajv (draft 2020-12). Fails if the schema
 *    itself is malformed.
 * 2. Take a known-good sample payload (authored by hand for this test).
 * 3. Assert Ajv accepts it.
 * 4. Assert the zod mirror also parses it.
 * 5. Break the payload in a targeted way and assert Ajv rejects AND zod rejects.
 *
 * If either side drifts, CI fails.
 */

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';

import {
  ingestAuditEntrySchema,
  jsonSchemas,
  mcpAuthorizationSchema,
  memoryItemSchema,
  renderRequestSchema,
  systemAuditEntrySchema,
  userQuotaSchema,
} from '../src/index.js';

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats.default(ajv);

// --- Fixtures --------------------------------------------------------------

const uuid = () => '00000000-0000-4000-8000-000000000000';
const iso = '2026-04-17T18:30:00Z';
const sha = '0'.repeat(64);

const renderRequestFixture = {
  id: uuid(),
  userId: 'user_abc',
  aspectRatio: '9:16',
  durationSec: 3,
  fps: 30,
  scenes: [
    {
      id: 'scene-0',
      startSec: 0,
      endSec: 3,
      layers: [
        {
          kind: 'faceCam',
          id: 'face-0',
          sourceUri: 'https://cdn.example.com/face.mp4',
        },
      ],
    },
  ],
  output: {
    container: 'mp4',
    videoCodec: 'h264',
    audioCodec: 'aac',
    videoBitrateKbps: 6000,
    audioBitrateKbps: 192,
  },
  createdAt: iso,
} as const;

const memoryItemFixture = {
  id: uuid(),
  userId: 'user_abc',
  source: 'file',
  kind: 'document',
  title: 'Resume.pdf',
  summary: 'One-page resume',
  chunks: 4,
  mcpExposed: false,
  sensitive: false,
  syncStatus: 'manual',
  createdAt: iso,
  updatedAt: iso,
  sha256: sha,
  sizeBytes: 1024,
  mimeReal: 'application/pdf',
  avVerdict: 'clean',
  avEngine: 'clamav-1.3.0',
  sanitized: false,
  quotaBytesCharged: 1024,
} as const;

const userQuotaFixture = {
  userId: 'user_abc',
  plan: 'creator',
  storageUsedBytes: 1_000_000,
  storageLimitBytes: 10_737_418_240,
  uploadsToday: 3,
  uploadsDailyLimit: 100,
  bytesToday: 500_000,
  bytesDailyLimit: 10_737_418_240,
  videosThisCycle: 2,
  videosCycleLimit: 60,
  seatsUsed: 1,
  seatsLimit: 1,
  maxUploadFileBytes: 524_288_000,
  resetsAt: iso,
  cycleResetsAt: iso,
  llmKeyProvider: 'anthropic',
  llmKeyStatus: 'active',
  infectionEscalationStep: 0,
} as const;

const ingestAuditFixture = {
  id: uuid(),
  userId: 'user_abc',
  source: 'file',
  filename: 'resume.pdf',
  sizeBytes: 1024,
  mimeDeclared: 'application/pdf',
  mimeReal: 'application/pdf',
  sha256: sha,
  avVerdict: 'clean',
  avEngine: 'clamav-1.3.0',
  scanDurationMs: 120,
  verdict: 'accepted',
  reason: null,
  timestamp: iso,
} as const;

const systemAuditFixture = {
  id: uuid(),
  sequence: 1,
  occurredAt: iso,
  actor: { kind: 'user', id: 'user_abc' },
  action: 'ingest.accepted',
  prevHash: sha,
  rowHash: sha,
} as const;

const mcpAuthFixture = {
  id: uuid(),
  userId: 'user_abc',
  agentId: 'claude-desktop-local-8f3a',
  displayName: 'Claude Desktop',
  apiKeyHash: sha,
  scopes: ['learnings'],
  createdAt: iso,
} as const;

// --- Schema compile sanity -------------------------------------------------

describe('JSON Schemas compile as draft 2020-12', () => {
  for (const [name, schema] of Object.entries(jsonSchemas)) {
    it(`compiles ${name}`, () => {
      expect(() => ajv.compile(schema)).not.toThrow();
    });
  }
});

// --- Happy path: both layers accept the fixture ----------------------------

describe('both JSON Schema and zod accept the fixture', () => {
  const cases: ReadonlyArray<
    readonly [
      string,
      ReturnType<(typeof ajv)['compile']>,
      { parse: (x: unknown) => unknown },
      unknown,
    ]
  > = [
    ['RenderRequest', ajv.compile(jsonSchemas.RenderRequest), renderRequestSchema, renderRequestFixture],
    ['MemoryItem', ajv.compile(jsonSchemas.MemoryItem), memoryItemSchema, memoryItemFixture],
    ['UserQuota', ajv.compile(jsonSchemas.UserQuota), userQuotaSchema, userQuotaFixture],
    ['IngestAuditEntry', ajv.compile(jsonSchemas.IngestAuditEntry), ingestAuditEntrySchema, ingestAuditFixture],
    ['SystemAuditEntry', ajv.compile(jsonSchemas.SystemAuditEntry), systemAuditEntrySchema, systemAuditFixture],
    ['McpAuthorization', ajv.compile(jsonSchemas.McpAuthorization), mcpAuthorizationSchema, mcpAuthFixture],
  ];

  for (const [name, validate, zodSchema, fixture] of cases) {
    it(`accepts ${name}`, () => {
      const jsonOk = validate(fixture);
      if (!jsonOk) {
        console.error(`${name} JSON Schema errors:`, validate.errors);
      }
      expect(jsonOk).toBe(true);
      expect(() => zodSchema.parse(fixture)).not.toThrow();
    });
  }
});

// --- Negative path: both layers reject a targeted corruption ---------------

describe('both JSON Schema and zod reject invalid fixtures', () => {
  it('RenderRequest: aspectRatio not in enum', () => {
    const broken = { ...renderRequestFixture, aspectRatio: '4:3' };
    const validate = ajv.compile(jsonSchemas.RenderRequest);
    expect(validate(broken)).toBe(false);
    expect(() => renderRequestSchema.parse(broken)).toThrow();
  });

  it('MemoryItem: sha256 wrong length', () => {
    const broken = { ...memoryItemFixture, sha256: 'abc' };
    const validate = ajv.compile(jsonSchemas.MemoryItem);
    expect(validate(broken)).toBe(false);
    expect(() => memoryItemSchema.parse(broken)).toThrow();
  });

  it('UserQuota: unknown plan', () => {
    const broken = { ...userQuotaFixture, plan: 'god-mode' };
    const validate = ajv.compile(jsonSchemas.UserQuota);
    expect(validate(broken)).toBe(false);
    expect(() => userQuotaSchema.parse(broken)).toThrow();
  });

  it('IngestAuditEntry: verdict not in enum', () => {
    const broken = { ...ingestAuditFixture, verdict: 'maybe' };
    const validate = ajv.compile(jsonSchemas.IngestAuditEntry);
    expect(validate(broken)).toBe(false);
    expect(() => ingestAuditEntrySchema.parse(broken)).toThrow();
  });

  it('SystemAuditEntry: prevHash not hex', () => {
    const broken = { ...systemAuditFixture, prevHash: 'ZZZZ' };
    const validate = ajv.compile(jsonSchemas.SystemAuditEntry);
    expect(validate(broken)).toBe(false);
    expect(() => systemAuditEntrySchema.parse(broken)).toThrow();
  });

  it('McpAuthorization: empty scopes', () => {
    const broken = { ...mcpAuthFixture, scopes: [] as string[] };
    const validate = ajv.compile(jsonSchemas.McpAuthorization);
    expect(validate(broken)).toBe(false);
    expect(() => mcpAuthorizationSchema.parse(broken)).toThrow();
  });
});
