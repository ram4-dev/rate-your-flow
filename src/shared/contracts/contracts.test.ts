import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ANALYSIS_ERROR_CODES,
  ANALYSIS_SCHEMA,
  assertSchemaTag,
  CONSENT_SCHEMA,
  DIGEST_DEFAULT_BUDGET_BYTES,
  DIGEST_MAX_SESSIONS,
  DIGEST_SCHEMA,
  DIGEST_WINDOW_DAYS,
  DIMENSIONS,
} from "./index.js";
import type {
  CitedSnippet,
  ConsentRecord,
  DigestV1,
  Dimension,
  DimensionScore,
  AnalyzeError,
  AnalysisErrorCode,
  AnalyzeRequest,
  AnalyzeResponse,
} from "./index.js";

describe("analysis@1 contract", () => {
  it("declares the schema version constant", () => {
    expect(ANALYSIS_SCHEMA).toBe("analysis@1");
  });

  it("exactly 10 error codes in contract order", () => {
    expect(ANALYSIS_ERROR_CODES).toEqual([
      "over_quota",
      "payment_required",
      "timeout",
      "quota_exhausted",
      "cost_ceiling",
      "oversized_payload",
      "endpoint_unreachable",
      "endpoint_redirected",
      "provider_unavailable",
      "invalid_model_response",
    ]);
  });

  it("error code union covers every code", () => {
    const sample: AnalysisErrorCode = "endpoint_redirected";
    expect(sample).toBe("endpoint_redirected");
  });

  it("AnalyzeError shape: incomplete outcome with code and optional retryAfterSeconds", () => {
    const err: AnalyzeError = {
      schema: "analysis@1",
      outcome: "incomplete",
      error: { code: "over_quota", retryAfterSeconds: 60 },
    };
    expect(err.error.retryAfterSeconds).toBe(60);
    // retryAfterSeconds is optional
    const bare: AnalyzeError = {
      schema: "analysis@1",
      outcome: "incomplete",
      error: { code: "timeout" },
    };
    expect(bare.error.retryAfterSeconds).toBeUndefined();
  });

  it("AnalyzeRequest shape carries installUUID and digest", () => {
    expectTypeOf<AnalyzeRequest>().toMatchTypeOf<{
      schema: "analysis@1";
      installUUID: string;
      digest: DigestV1;
    }>();
  });

  it("DimensionScore shape: optional score, evaluable flag, evidence refs, notes", () => {
    expectTypeOf<DimensionScore>().toMatchTypeOf<{
      dimension: Dimension;
      score?: number;
      evaluable: boolean;
      evidence: { sessionId: string; line: number }[];
      notes: string;
    }>();
  });

  it("AnalyzeResponse: complete outcome, exactly 5 dimensions, total iff 5/5, confidenceNote", () => {
    expectTypeOf<AnalyzeResponse["outcome"]>().toEqualTypeOf<"complete">();
    expectTypeOf<AnalyzeResponse["dimensions"]>().toEqualTypeOf<
      readonly [DimensionScore, DimensionScore, DimensionScore, DimensionScore, DimensionScore]
    >();
    expectTypeOf<AnalyzeResponse["total"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<AnalyzeResponse["confidenceNote"]>().toEqualTypeOf<string>();
  });
});

describe("digest@1 contract", () => {
  it("declares the schema version constant", () => {
    expect(DIGEST_SCHEMA).toBe("digest@1");
  });

  it("ships the 48 KiB default budget, 50-session cap, 90-day window", () => {
    expect(DIGEST_DEFAULT_BUDGET_BYTES).toBe(48 * 1024);
    expect(DIGEST_MAX_SESSIONS).toBe(50);
    expect(DIGEST_WINDOW_DAYS).toBe(90);
  });

  it("DigestV1 carries counters, eventSequences, episodes, citedSnippets", () => {
    expectTypeOf<DigestV1>().toMatchTypeOf<{
      schema: "digest@1";
      counters: Record<string, number>;
      eventSequences: {
        sessionId: string;
        events: { line: number; kind: string; ts?: string }[];
      }[];
      episodes: { sessionId: string; startLine: number; endLine: number; summary: string }[];
      citedSnippets: CitedSnippet[];
    }>();
  });

  it("CitedSnippet references sessionId, line, text", () => {
    expectTypeOf<CitedSnippet>().toEqualTypeOf<{
      sessionId: string;
      line: number;
      text: string;
    }>();
  });
});

describe("consent@1 contract", () => {
  it("declares the schema version constant", () => {
    expect(CONSENT_SCHEMA).toBe("consent@1");
  });

  it("ConsentRecord shape: version, state, destination, scopeVersion, timestamp", () => {
    expectTypeOf<ConsentRecord>().toMatchTypeOf<{
      version: "consent@1";
      state: "consented" | "refused";
      destination: string;
      scopeVersion: string;
      timestamp: string;
    }>();
    const rec: ConsentRecord = {
      version: "consent@1",
      state: "consented",
      destination: "https://example.com/analyze",
      scopeVersion: "scope@1",
      timestamp: "2026-02-07T19:00:00.000Z",
    };
    expect(rec.state).toBe("consented");
  });
});

describe("rubric dimension order", () => {
  it("five dimensions in scoring-spec order", () => {
    expect(DIMENSIONS).toEqual([
      "reliability",
      "communication",
      "context-efficiency",
      "productivity",
      "hygiene",
    ]);
  });
});

describe("runtime schema-tag guard", () => {
  it("accepts a matching schema tag", () => {
    expect(() => assertSchemaTag({ schema: "digest@1" }, "digest@1")).not.toThrow();
  });

  it("rejects a missing or mismatched schema tag", () => {
    expect(() => assertSchemaTag({ schema: "digest@2" }, "digest@1")).toThrow();
    expect(() => assertSchemaTag({}, "digest@1")).toThrow();
    expect(() => assertSchemaTag(null, "digest@1")).toThrow();
    expect(() => assertSchemaTag("digest@1", "digest@1")).toThrow();
  });
});
