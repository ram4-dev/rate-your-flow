import { describe, expect, it } from "vitest";
import { digestRefLookup, validateProviderResult } from "../../src/backend/providers/validate.js";
import type { DigestV1, DimensionScore } from "../../src/shared/contracts/index.js";
import { DIMENSIONS } from "../../src/shared/contracts/index.js";

const DIGEST: DigestV1 = {
  schema: "digest@1",
  counters: { sessions: 2 },
  eventSequences: [
    {
      sessionId: "s1",
      events: [
        { line: 1, kind: "message" },
        { line: 5, kind: "tool" },
      ],
    },
    { sessionId: "s2", events: [{ line: 3, kind: "message" }] },
  ],
  episodes: [{ sessionId: "s1", startLine: 1, endLine: 5, summary: "episode" }],
  citedSnippets: [{ sessionId: "s2", line: 3, text: "snippet" }],
};

function validDimensions(): DimensionScore[] {
  return DIMENSIONS.map((dimension, index) => ({
    dimension,
    score: 60 + index,
    evaluable: true,
    evidence: [{ sessionId: "s1", line: 1 }],
    notes: `note ${dimension}`,
  }));
}

describe("provider response validation (scoring spec: score+citation validation)", () => {
  it("accepts a valid all-evaluable result", () => {
    const result = validateProviderResult(
      { dimensions: validDimensions(), confidenceNote: "descriptive only" },
      DIGEST,
    );
    expect(result.ok).toBe(true);
  });

  it("rejects out-of-range scores (0-100)", () => {
    for (const score of [-1, 101, 1000.5]) {
      const dims = validDimensions();
      dims[0] = { ...dims[0]!, score };
      const result = validateProviderResult({ dimensions: dims, confidenceNote: "n" }, DIGEST);
      expect(result.ok).toBe(false);
    }
  });

  it("rejects non-numeric scores on evaluable dimensions", () => {
    const dims = validDimensions().map((d) => ({ ...d, score: "high" as unknown as number }));
    const result = validateProviderResult({ dimensions: dims, confidenceNote: "n" }, DIGEST);
    expect(result.ok).toBe(false);
  });

  it("rejects citations that do not resolve to digest references", () => {
    const dims = validDimensions().map((d) => ({
      ...d,
      evidence: [{ sessionId: "sX", line: 1 }],
    }));
    const result = validateProviderResult({ dimensions: dims, confidenceNote: "n" }, DIGEST);
    expect(result.ok).toBe(false);

    const wrongLine = validDimensions().map((d) => ({
      ...d,
      evidence: [{ sessionId: "s1", line: 99 }],
    }));
    expect(validateProviderResult({ dimensions: wrongLine, confidenceNote: "n" }, DIGEST).ok).toBe(
      false,
    );
  });

  it("rejects not-evaluable dimensions that carry a fabricated score", () => {
    const dims = validDimensions();
    dims[2] = { ...dims[2]!, evaluable: false, score: 70 };
    const result = validateProviderResult({ dimensions: dims, confidenceNote: "n" }, DIGEST);
    expect(result.ok).toBe(false);
  });

  it("accepts not-evaluable dimensions without a score", () => {
    const dims = validDimensions();
    const { score: _omitted, ...withoutScore } = dims[4]!;
    dims[4] = { ...withoutScore, evaluable: false };
    const result = validateProviderResult({ dimensions: dims, confidenceNote: "n" }, DIGEST);
    expect(result.ok).toBe(true);
  });

  it("rejects results with missing/duplicated/misordered dimensions", () => {
    const missing = validDimensions().slice(0, 4);
    expect(validateProviderResult({ dimensions: missing, confidenceNote: "n" }, DIGEST).ok).toBe(
      false,
    );
    const duplicated = [...validDimensions()];
    duplicated[1] = duplicated[0]!;
    expect(validateProviderResult({ dimensions: duplicated, confidenceNote: "n" }, DIGEST).ok).toBe(
      false,
    );
  });

  it("empty evidence on an evaluable dimension is rejected (not evaluable instead)", () => {
    const dims = validDimensions().map((d) => ({ ...d, evidence: [] }));
    expect(validateProviderResult({ dimensions: dims, confidenceNote: "n" }, DIGEST).ok).toBe(
      false,
    );
  });

  it("digestRefLookup resolves session+line across eventSequences and citedSnippets", () => {
    expect(digestRefLookup(DIGEST)("s1", 5)).toBe(true);
    expect(digestRefLookup(DIGEST)("s2", 3)).toBe(true);
    expect(digestRefLookup(DIGEST)("s2", 4)).toBe(false);
  });
});
