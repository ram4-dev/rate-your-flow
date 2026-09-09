import { describe, expect, it } from "vitest";
import { HttpProviderStub } from "../../src/backend/providers/stub.js";
import { validateProviderResult } from "../../src/backend/providers/validate.js";
import type { DigestV1 } from "../../src/shared/contracts/index.js";
import { DIMENSIONS } from "../../src/shared/contracts/index.js";

const DIGEST: DigestV1 = {
  schema: "digest@1",
  counters: { sessions: 2 },
  eventSequences: [
    {
      sessionId: "s1",
      events: [
        { line: 1, kind: "message" },
        { line: 2, kind: "tool" },
      ],
    },
    { sessionId: "s2", events: [{ line: 7, kind: "message" }] },
  ],
  episodes: [],
  citedSnippets: [{ sessionId: "s1", line: 2, text: "snippet" }],
};

const EMPTY_DIGEST: DigestV1 = {
  schema: "digest@1",
  counters: {},
  eventSequences: [],
  episodes: [],
  citedSnippets: [],
};

describe("HttpProviderStub (deterministic, schema-valid)", () => {
  it("ok mode: five dimensions, evaluable, citations resolve, validation passes", async () => {
    const stub = new HttpProviderStub({ mode: "ok" });
    const result = await stub.analyze(DIGEST, { timeoutMs: 1000 });
    expect(result.dimensions).toHaveLength(5);
    expect(result.dimensions.map((d) => d.dimension)).toEqual([...DIMENSIONS]);
    for (const d of result.dimensions) {
      expect(d.evaluable).toBe(true);
      expect(d.score).toBeGreaterThanOrEqual(0);
      expect(d.score).toBeLessThanOrEqual(100);
    }
    expect(validateProviderResult(result, DIGEST).ok).toBe(true);
  });

  it("ok mode with no digest refs: all dimensions not evaluable, no fabricated scores", async () => {
    const stub = new HttpProviderStub({ mode: "ok" });
    const result = await stub.analyze(EMPTY_DIGEST, { timeoutMs: 1000 });
    for (const d of result.dimensions) {
      expect(d.evaluable).toBe(false);
      expect(d.score).toBeUndefined();
    }
    expect(validateProviderResult(result, EMPTY_DIGEST).ok).toBe(true);
  });

  it("rate_limited mode: ProviderFailure over_quota with retryAfterSeconds", async () => {
    const stub = new HttpProviderStub({ mode: "rate_limited" });
    await expect(stub.analyze(DIGEST, { timeoutMs: 1000 })).rejects.toMatchObject({
      code: "over_quota",
      retryAfterSeconds: 45,
    });
  });

  it("payment_required mode: ProviderFailure payment_required, no paid fallback", async () => {
    const stub = new HttpProviderStub({ mode: "payment_required" });
    await expect(stub.analyze(DIGEST, { timeoutMs: 1000 })).rejects.toMatchObject({
      code: "payment_required",
    });
  });

  it("invalid mode: emits garbage that validation rejects (handler maps to invalid_model_response)", async () => {
    const stub = new HttpProviderStub({ mode: "invalid" });
    const result = await stub.analyze(DIGEST, { timeoutMs: 1000 });
    expect(validateProviderResult(result, DIGEST).ok).toBe(false);
  });

  it("honors abort signal: abort during delay rejects", async () => {
    const stub = new HttpProviderStub({ mode: "ok", delayMs: 200 });
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("timeout")), 30);
    await expect(
      stub.analyze(DIGEST, { timeoutMs: 1000, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "timeout" });
  });
});
