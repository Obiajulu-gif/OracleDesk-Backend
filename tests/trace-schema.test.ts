import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setupTestEnv } from './helpers/env';
import {
  TraceDocV1, TraceDocV2, TraceDocAny, LegacyTraceDoc, buildTraceDoc, buildTraceDocV2, classifyTraceDoc, fromContractsTrace,
} from '../src/schemas/trace';
import { assertPlainJson } from '../src/utils/hash.util';
import { QuestionDocV1, QuestionDocV2 } from '../src/schemas/question';

// Build question documents in the same shape `market-chain.service.ts`
// pins. The old local `questionDocument` builder in `src/schemas/question.ts`
// emitted a different shape and was removed in #234.
function buildQuestionV1(input: {
  id: string;
  question: string;
  category: string;
  contractCategory: string;
  closeTime: number;
  resolutionSource: string | null;
  resolutionHash: string;
}) {
  return {
    version: 1 as const,
    question: input.question,
    category: input.category,
    contractCategory: input.contractCategory,
    closeTime: input.closeTime,
    resolutionSource: input.resolutionSource,
    resolutionHash: input.resolutionHash,
    backendMarketId: input.id,
  };
}

function buildQuestionV2(input: {
  id: string;
  question: string;
  category: string;
  contractCategory: string;
  closeTime: number;
  resolutionSource: string | null;
  resolutionHash: string;
  resolution: Record<string, unknown>;
}) {
  return { ...buildQuestionV1(input), version: 2 as const, resolution: input.resolution };
}
import { canonicalJson, canonicalJsonStrict, verifyTraceHash } from '../src/utils/hash.util';
import { pinDocument, setIpfsTransportForTests } from '../src/services/ipfs.service';
import { generateSchemas } from '../src/schemas/generate';

setupTestEnv();

// Compiled to dist-tests/tests: fixtures stay in the source tree.
const FIXTURES = path.join(__dirname, '..', '..', 'tests', 'fixtures');

test('buildTraceDoc output validates against TraceDocV1 for market-maker and trader inputs', () => {
  const mmDoc = buildTraceDoc({
    traceId: '11111111-1111-4111-8111-111111111111',
    agentType: 'MARKET_MAKER',
    decisionType: 'MARKET_CREATION',
    action: 'create_market',
    backendMarketId: '22222222-2222-4222-8222-222222222222',
    onChainMarketId: '0',
    probabilityEstimate: 0.65,
    marketProbability: 0.5,
    edge: 0.15,
    confidenceInterval: { lower: 0.55, upper: 0.75 },
    sourcesUsed: [{ source: 'FRED', weight: 0.8, signal: 'Rates drop', rawValue: 0.5 }],
    betFraction: null,
    betSizeUsdc: null,
    hedgeConditions: ['CPI > 3.0%'],
  });

  assert.equal(mmDoc.schemaVersion, 1);
  assert.equal(mmDoc.kind, 'oracledesk.trace');
  assert.equal(mmDoc.agentType, 'MARKET_MAKER');
  assert.equal(mmDoc.action, 'create_market');
  assert.equal(mmDoc.market.onChainId, '0');
  assert.doesNotThrow(() => TraceDocV1.parse(mmDoc));

  const traderDoc = buildTraceDoc({
    traceId: '33333333-3333-4333-8333-333333333333',
    agentType: 'TRADER',
    decisionType: 'BUY_YES',
    action: 'buy_yes',
    backendMarketId: '22222222-2222-4222-8222-222222222222',
    onChainMarketId: 1,
    probabilityEstimate: 0.8,
    marketProbability: 0.6,
    edge: 0.2,
    confidenceInterval: { lower: 0.75, upper: 0.85 },
    sourcesUsed: [{ source: 'NEWSAPI', weight: 0.9, signal: 'Approval likely', rawValue: 1 }],
    betFraction: 0.05,
    betSizeUsdc: 50,
  });

  assert.equal(traderDoc.agentType, 'TRADER');
  assert.equal(traderDoc.betFraction, 0.05);
  assert.equal(traderDoc.betSizeUsdc, 50);
  assert.doesNotThrow(() => TraceDocV1.parse(traderDoc));
});

test('trace doc never contains undefined and canonicalJsonStrict round-trips', () => {
  const doc = buildTraceDoc({
    traceId: '11111111-1111-4111-8111-111111111111',
    agentType: 'MARKET_MAKER',
    decisionType: 'MARKET_CREATION',
    action: 'create_market',
    backendMarketId: '22222222-2222-4222-8222-222222222222',
    onChainMarketId: null,
    probabilityEstimate: 0.5,
    marketProbability: 0.5,
    edge: 0.0,
    confidenceInterval: { lower: 0.4, upper: 0.6 },
    sourcesUsed: [],
  });

  // Must not throw with strict canonicalization
  const canonical = canonicalJsonStrict(doc);
  assert.ok(typeof canonical === 'string');
  assert.ok(!canonical.includes('undefined'));

  // Round trip parse and check identical bytes
  const parsed = JSON.parse(canonical);
  const reCanonical = canonicalJsonStrict(parsed);
  assert.equal(canonical, reCanonical);
});

test('pinDocument refuses an invalid trace and never calls the transport', async () => {
  let transportCalled = false;
  setIpfsTransportForTests(async () => {
    transportCalled = true;
    return { cid: 'fake-cid', size: 100 };
  });

  try {
    const invalidDoc = {
      schemaVersion: 1,
      kind: 'oracledesk.trace',
      // missing traceId and required fields
    };

    await assert.rejects(
      async () => {
        await pinDocument(TraceDocV1, invalidDoc as any, 'invalid-trace');
      },
      (err: any) => {
        return err.name === 'AppError' || err.message.includes('DOCUMENT_SCHEMA_INVALID');
      },
    );

    assert.equal(transportCalled, false);
  } finally {
    setIpfsTransportForTests(null);
  }
});

test('question v1 documents for existing markets validate and hash predictably', () => {
  const v1 = buildQuestionV1({
    id: '22222222-2222-4222-8222-222222222222',
    question: 'Will the Fed cut rates by 25bps?',
    category: 'FED',
    contractCategory: 'Macro',
    closeTime: Math.floor(1729000000000 / 1000),
    resolutionSource: 'FRED',
    resolutionHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  });

  assert.equal(v1.version, 1);
  assert.doesNotThrow(() => QuestionDocV1.parse(v1));
});

test('question v2 document validates and pins', async () => {
  let transportCalled = false;
  setIpfsTransportForTests(async () => {
    transportCalled = true;
    return { cid: 'test-cid-question-v2', size: 120 };
  });

  try {
    const v2 = buildQuestionV2({
      id: '22222222-2222-4222-8222-222222222222',
      question: 'Will the Fed cut rates by 25bps in 2026?',
      category: 'FED',
      contractCategory: 'Macro',
      closeTime: Math.floor(1782777600000 / 1000),
      resolutionSource: 'FRED',
      resolutionHash: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
      resolution: { outcome: 'pending' },
    });

    assert.equal(v2.version, 2);
    assert.doesNotThrow(() => QuestionDocV2.parse(v2));

    // The builder returns loose string fields; pin the schema-typed parse of it.
    const pinned = await pinDocument(QuestionDocV2, QuestionDocV2.parse(v2), 'test-question-v2');
    assert.equal(pinned.cid, 'test-cid-question-v2');
    assert.equal(transportCalled, true);
  } finally {
    setIpfsTransportForTests(null);
  }
});

test('legacy trace without schemaVersion verifies by hash and reports schemaVersion 0', () => {
  const legacy = {
    traceId: '11111111-1111-4111-8111-111111111111',
    agentType: 'MARKET_MAKER',
    action: 'create_market',
    probability: 0.65,
    reasoning: 'Legacy unversioned reasoning payload',
  };

  const bytes = Buffer.from(canonicalJson(legacy), 'utf8');
  const hash = require('crypto').createHash('sha256').update(bytes).digest('hex');

  const verified = verifyTraceHash(bytes, hash);
  assert.equal(verified, true);

  const parsed = JSON.parse(bytes.toString('utf8'));
  const isV1 = TraceDocV1.safeParse(parsed).success;
  const isLegacy = LegacyTraceDoc.safeParse(parsed).success;

  assert.equal(isV1, false);
  assert.equal(isLegacy, true);
  const reportedVersion = (parsed as any).schemaVersion ?? 0;
  assert.equal(reportedVersion, 0);
});

test('backend canonicalJson matches contracts canonicalize on shared fixtures', () => {
  const fixturePath = path.join(FIXTURES, 'contracts-trace.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

  // Contracts canonicalize sorts keys recursively and drops undefined
  const cJson = canonicalJson(fixture);
  const strictJson = canonicalJsonStrict(fixture);
  assert.equal(cJson, strictJson);
});

test('fromContractsTrace maps the contracts fixture to a valid TraceDocV1', () => {
  const fixturePath = path.join(FIXTURES, 'contracts-trace.json');
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

  const v1 = fromContractsTrace(fixture);
  assert.equal(v1.schemaVersion, 1);
  assert.equal(v1.kind, 'oracledesk.trace');
  assert.equal(v1.agentType, 'MARKET_MAKER');
  assert.equal(v1.action, 'create_market');
  assert.equal(v1.market.onChainId, '0');
  assert.equal(v1.sourcesUsed.length, 2);
  assert.doesNotThrow(() => TraceDocV1.parse(v1));
});

test('committed JSON schemas are up to date', () => {
  const ok = generateSchemas({ check: true });
  assert.equal(ok, true, 'Committed JSON schemas must match generator output');
});

// ─── v2 (#227) ───────────────────────────────────────────────────────────────

const NOW = new Date('2026-10-17T00:00:00.000Z');
const PROVENANCE = {
  schema: 'oracledesk.trace.provenance/1' as const,
  llm: [
    {
      source: 'llm' as const, provider: 'anthropic' as const, model: 'recorded',
      promptId: 'market-proposal', promptVersion: 1, promptHash: 'ab'.repeat(32),
      params: { temperature: 0, maxTokens: 1024 }, usage: null, latencyMs: 12, attempts: 1,
      outputSha256: 'cd'.repeat(32),
    },
    { source: 'default' as const, promptId: 'hedge-conditions', promptVersion: 1, reason: 'LLM_FAILED' as const },
  ],
  generator: { service: 'oracledesk-backend' as const, version: '1.0.0' },
};

function mmParams() {
  return {
    traceId: '11111111-1111-4111-8111-111111111111',
    agentType: 'MARKET_MAKER' as const,
    decisionType: 'MARKET_CREATION',
    action: 'market_creation',
    backendMarketId: '22222222-2222-4222-8222-222222222222',
    onChainMarketId: null,
    probabilityEstimate: 0.65,
    marketProbability: 0.62,
    edge: 0.03,
    confidenceInterval: { lower: 0.55, upper: 0.75 },
    sourcesUsed: [
      {
        source: 'NEWSAPI', weight: 0.8, signal: 'Fed signals a pause', signalId: 'sig_01',
        url: 'https://example.com/fed', publisher: 'Example Wire', publishedAt: new Date('2026-10-16T12:00:00Z') as unknown as string,
      },
      { source: 'FRED', weight: 0.9, signal: 'FEDFUNDS 4.33', rawValue: 4.33 },
    ],
    hedgeConditions: ['Close if market probability rises above 0.75'],
    provenance: PROVENANCE,
    seedPolicy: { seedRaw: 100_000_000n, initialYesBps: 6200, decidedAt: new Date('2026-10-16T00:00:00Z'), note: undefined },
  };
}

function traderParams() {
  return {
    ...mmParams(),
    traceId: '33333333-3333-4333-8333-333333333333',
    agentType: 'TRADER' as const,
    decisionType: 'OPEN_POSITION',
    action: 'open_position',
    onChainMarketId: 7n,
    betFraction: 0.05,
    betSizeUsdc: 50,
    seedPolicy: null,
    forecast: { p: 0.66, members: [{ model: 'base-rate', p: 0.6, weight: 0.4 }, { model: 'llm', p: 0.7, weight: 0.6, extra: undefined }] },
    sizing: { kellyUsdc: 80, finalUsdc: 50, binding: 'correlation', budget: { freeRaw: '1000000000' } },
    correlation: {
      pairs: [{ marketId: 'other', rho: 0.4, exposureRaw: 5n, at: new Date('2026-10-16T00:00:00Z') }],
      method: 'snapshot' as const,
      snapshotId: 'snap-1',
    },
  };
}

test('buildTraceDocV2 validates market-maker input: null onChainId, seed policy, full evidence', () => {
  const doc = buildTraceDocV2(mmParams(), NOW);
  assert.equal(doc.schemaVersion, 2);
  assert.equal(doc.market.onChainId, null);
  assert.deepEqual(doc.seedPolicy, { seedRaw: '100000000', initialYesBps: 6200, decidedAt: '2026-10-16T00:00:00.000Z' });
  assert.equal(doc.forecast, null);
  assert.equal(doc.sizing, null);
  assert.equal(doc.correlation, null);
  assert.deepEqual(doc.sourcesUsed[0], {
    source: 'NEWSAPI', weight: 0.8, signal: 'Fed signals a pause', rawValue: null, signalId: 'sig_01',
    url: 'https://example.com/fed', publisher: 'Example Wire', publishedAt: '2026-10-16T12:00:00.000Z',
  });
  assert.deepEqual(doc.sourcesUsed[1], {
    source: 'FRED', weight: 0.9, signal: 'FEDFUNDS 4.33', rawValue: 4.33, signalId: null, url: null, publisher: null, publishedAt: null,
  });
  assert.equal(doc.provenance.llm.length, 2);
  assert.doesNotThrow(() => TraceDocV2.parse(doc));
  assert.doesNotThrow(() => assertPlainJson(doc));
  assert.equal(canonicalJson(doc), canonicalJsonStrict(doc), 'canonicalisable without loss');
});

test('buildTraceDocV2 validates trader input: forecast, sizing, correlation', () => {
  const doc = buildTraceDocV2(traderParams(), NOW);
  assert.equal(doc.market.onChainId, '7');
  assert.equal(doc.betFraction, 0.05);
  assert.deepEqual(doc.correlation, {
    pairs: [{ marketId: 'other', rho: 0.4, exposureRaw: '5', at: '2026-10-16T00:00:00.000Z' }],
    method: 'snapshot',
    snapshotId: 'snap-1',
  });
  assert.deepEqual((doc.forecast as any).members[1], { model: 'llm', p: 0.7, weight: 0.6 }, 'undefined keys dropped');
  assert.equal((doc.sizing as any).binding, 'correlation');
  assert.doesNotThrow(() => assertPlainJson(doc));
  assert.equal(canonicalJson(doc), canonicalJsonStrict(doc));
});

test('buildTraceDocV2 takes createdAt from the injected clock, so replays produce identical bytes', () => {
  const a = buildTraceDocV2(traderParams(), NOW);
  const b = buildTraceDocV2(traderParams(), new Date(NOW.getTime()));
  assert.equal(a.createdAt, '2026-10-17T00:00:00.000Z');
  assert.equal(canonicalJson(a), canonicalJson(b));
  const later = buildTraceDocV2(traderParams(), new Date('2026-10-18T00:00:00Z'));
  assert.equal(later.createdAt, '2026-10-18T00:00:00.000Z');
});

test('TraceDocV2 rejects unknown top-level keys and v1-shaped evidence', () => {
  const doc = buildTraceDocV2(mmParams(), NOW);
  assert.equal(TraceDocV2.safeParse({ ...doc, onChainMarketId: '7' }).success, false, 'the old spread is rejected');
  assert.equal(
    TraceDocV2.safeParse({ ...doc, sourcesUsed: [{ source: 'FRED', weight: 0.5, signal: 'x', rawValue: null }] }).success,
    false,
    'every evidence key is required',
  );
  assert.equal(TraceDocV2.safeParse({ ...doc, provenance: { ...doc.provenance, llm: [] } }).success, false, 'llm is never empty');
  assert.equal(
    TraceDocV2.safeParse({ ...doc, confidenceInterval: { lower: 0.8, upper: 0.2 } }).success,
    false,
    'ci refinement carries over from v1',
  );
});

test('buildTraceDocV2 rejects class instances in loosely typed records', () => {
  class Opaque { x = 1; }
  assert.throws(() => buildTraceDocV2({ ...traderParams(), sizing: { thing: new Opaque() } as any }, NOW), /not plain JSON/);
});

test('TraceDocAny classifies v2, v1 and legacy documents in that order', () => {
  const v2 = buildTraceDocV2(mmParams(), NOW);
  const v1 = fromContractsTrace(JSON.parse(fs.readFileSync(path.join(FIXTURES, 'contracts-trace.json'), 'utf8')));
  const legacy = { traceId: 't', agentType: 'MARKET_MAKER', timestamp: '2026-01-01T00:00:00Z', onChainMarketId: null };
  assert.equal(classifyTraceDoc(v2), 'v2');
  assert.equal(classifyTraceDoc(v1), 'v1');
  assert.equal(classifyTraceDoc(legacy), 'legacy');
  assert.equal(classifyTraceDoc('not an object'), 'invalid');
  // The union yields the parsed v2 object (strict), not the passthrough record.
  assert.deepEqual(TraceDocAny.parse(v2), v2);
  assert.equal(TraceDocV1.safeParse(v2).success, false, 'v1 is unchanged and still rejects v2 fields');
});
