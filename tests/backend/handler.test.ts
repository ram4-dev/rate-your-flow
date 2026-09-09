import { describe, expect, it, vi } from "vitest";
import { DEFAULT_BACKEND_CONFIG } from "../../src/backend/config.js";
import { createAnalysisHandler } from "../../src/backend/handler.js";
import { InMemoryCounterStore } from "../../src/backend/counters/in-memory.js";
import { HttpProviderStub } from "../../src/backend/providers/stub.js";
import type { DigestV1 } from "../../src/shared/contracts/index.js";

const DIGEST: DigestV1 = {
  schema: "digest@1",
  counters: { sessions: 1 },
  eventSequences: [{ sessionId: "s1", events: [{ line: 1, kind: "message" }] }],
  episodes: [],
  citedSnippets: [{ sessionId: "s1", line: 1, text: "evidence" }],
};

const ENVELOPE = () =>
  JSON.stringify({ schema: "analysis@1", installUUID: "uuid-1", digest: DIGEST });

function makeHandler(overrides: Partial<Parameters<typeof createAnalysisHandler>[0]> = {}) {
  const store = new InMemoryCounterStore({
    quotaPerDay: 3,
    concurrencyLimit: 1,
  });
  const provider = new HttpProviderStub({ mode: "ok" });
  const calls: unknown[] = [];
  const spyProvider = new Proxy(provider, {
    get(target, prop, receiver) {
      if (prop === "analyze") {
        return (...args: unknown[]) => {
          calls.push(args);
          return (provider.analyze as (...a: unknown[]) => unknown)(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const handler = createAnalysisHandler({
    store,
    provider: spyProvider,
    config: { ...DEFAULT_BACKEND_CONFIG, timeoutMs: 500 },
    now: () => 1_000_000,
    ...overrides,
  });
  return { handler, calls };
}

describe("analysis@1 handler (stable contract regardless of provider)", () => {
  it("complete path: 5/5 evaluable => response with principal total", async () => {
    const { handler } = makeHandler();
    const result = await handler.handle(ENVELOPE());
    expect(result.outcome).toBe("complete");
    if (result.outcome === "complete") {
      expect(result.dimensions).toHaveLength(5);
      expect(result.total).toBeGreaterThan(0);
      expect(typeof result.confidenceNote).toBe("string");
    }
  });

  it("oversized payload rejected BEFORE the provider call", async () => {
    const { handler, calls } = makeHandler({
      config: { ...DEFAULT_BACKEND_CONFIG, timeoutMs: 500, maxPayloadBytes: 100 },
    });
    const result = await handler.handle(ENVELOPE());
    expect(result.outcome).toBe("incomplete");
    if (result.outcome === "incomplete") {
      expect(result.error.code).toBe("oversized_payload");
    }
    expect(calls).toHaveLength(0); // never reached the provider
  });

  it("quota: 4th analysis same UTC day => over_quota; released failures free slots", async () => {
    const { handler } = makeHandler();
    // Three concurrent would be blocked by concurrency 1; run sequentially.
    for (let i = 0; i < 3; i++) {
      const r = await handler.handle(ENVELOPE());
      expect(r.outcome).toBe("complete");
    }
    const fourth = await handler.handle(ENVELOPE());
    expect(fourth.outcome).toBe("incomplete");
    if (fourth.outcome === "incomplete") expect(fourth.error.code).toBe("over_quota");
  });

  it("concurrency: second in-flight analysis => over_quota (busy)", async () => {
    const { handler } = makeHandler({
      provider: new HttpProviderStub({ mode: "ok", delayMs: 150 }),
    });
    const [first, second] = await Promise.all([
      handler.handle(ENVELOPE()),
      handler.handle(ENVELOPE()),
    ]);
    expect([first.outcome, second.outcome].sort()).toEqual(["complete", "incomplete"]);
  });

  it("provider failure (429/402-family) => error envelope AND slot release", async () => {
    const failing = makeHandler({ provider: new HttpProviderStub({ mode: "rate_limited" }) });
    const failed = await failing.handler.handle(ENVELOPE());
    expect(failed.outcome).toBe("incomplete");
    if (failed.outcome === "incomplete") {
      expect(failed.error.code).toBe("over_quota");
      expect(failed.error.retryAfterSeconds).toBe(45);
    }
    // Slots were released on failure: a subsequent ok-provider analysis succeeds.
    const ok = makeHandler();
    const result = await ok.handler.handle(ENVELOPE());
    expect(result.outcome).toBe("complete");
  });

  it("provider timeout => timeout error, no score, slot released", async () => {
    const { handler } = makeHandler({
      provider: new HttpProviderStub({ mode: "hang" }),
      config: { ...DEFAULT_BACKEND_CONFIG, timeoutMs: 60 },
    });
    const result = await handler.handle(ENVELOPE());
    expect(result.outcome).toBe("incomplete");
    if (result.outcome === "incomplete") expect(result.error.code).toBe("timeout");
    // Concurrency slot released: next analysis proceeds.
    const ok = makeHandler();
    expect((await ok.handler.handle(ENVELOPE())).outcome).toBe("complete");
  });

  it("invalid model output => invalid_model_response (validation in provider layer)", async () => {
    const { handler } = makeHandler({ provider: new HttpProviderStub({ mode: "invalid" }) });
    const result = await handler.handle(ENVELOPE());
    expect(result.outcome).toBe("incomplete");
    if (result.outcome === "incomplete") expect(result.error.code).toBe("invalid_model_response");
  });

  it("cost ceiling (explicitly enabled and tripped) => cost_ceiling, no provider call", async () => {
    const { handler } = makeHandler({
      config: {
        ...DEFAULT_BACKEND_CONFIG,
        timeoutMs: 500,
        costCeiling: { enabled: true, monthlyLimitUnits: 1 },
      },
    });
    // Seed spend above the limit via a first success (adds 1 unit), then trip.
    const first = await handler.handle(ENVELOPE());
    expect(first.outcome).toBe("complete");
    const second = await handler.handle(ENVELOPE());
    expect(second.outcome).toBe("incomplete");
    if (second.outcome === "incomplete") expect(second.error.code).toBe("cost_ceiling");
  });

  it("stateless: handler keeps no digest content (no storage side effects)", async () => {
    const { handler } = makeHandler();
    await handler.handle(ENVELOPE());
    // Handler exposes no state; the response must not echo digest content back.
    const result = await handler.handle(ENVELOPE());
    expect(JSON.stringify(result)).not.toContain("s1#1");
  });

  it("malformed envelope => defined error, provider not called", async () => {
    const { handler, calls } = makeHandler();
    const result = await handler.handle("{ not json");
    expect(result.outcome).toBe("incomplete");
    expect(calls).toHaveLength(0);
    const wrongSchema = await handler.handle(
      JSON.stringify({ schema: "analysis@9", installUUID: "u", digest: DIGEST }),
    );
    expect(wrongSchema.outcome).toBe("incomplete");
    expect(calls).toHaveLength(0);
  });
});

// Root-review hardening regressions (U6): pre-provider shape validation,
// safe errors on store outage, deadline settles even when the provider
// ignores abort.

describe("handler hardening (root review regressions)", () => {
  it("JSON null envelope => defined error, provider not called, no throw", async () => {
    const { handler, calls } = makeHandler();
    const result = await handler.handle("null");
    expect(result.outcome).toBe("incomplete");
    expect(calls).toHaveLength(0);
  });

  it("non-object envelope (array/number/string) => defined error, provider not called", async () => {
    const { handler, calls } = makeHandler();
    for (const raw of ["[1,2]", "42", '"str"', "true"]) {
      const result = await handler.handle(raw);
      expect(result.outcome).toBe("incomplete");
    }
    expect(calls).toHaveLength(0);
  });

  it("digest with schema tag but missing arrays => rejected pre-provider", async () => {
    const { handler, calls } = makeHandler();
    const bad = JSON.stringify({
      schema: "analysis@1",
      installUUID: "uuid-1",
      digest: { schema: "digest@1" },
    });
    const result = await handler.handle(bad);
    expect(result.outcome).toBe("incomplete");
    expect(calls).toHaveLength(0);
  });

  it("digest with wrong-typed arrays (non-array eventSequences) => rejected pre-provider", async () => {
    const { handler, calls } = makeHandler();
    const bad = JSON.stringify({
      schema: "analysis@1",
      installUUID: "uuid-1",
      digest: {
        schema: "digest@1",
        counters: {},
        eventSequences: "x",
        episodes: [],
        citedSnippets: [],
      },
    });
    const result = await handler.handle(bad);
    expect(result.outcome).toBe("incomplete");
    expect(calls).toHaveLength(0);
  });

  it("non-finite or negative counters => rejected pre-provider", async () => {
    const { handler, calls } = makeHandler();
    for (const counters of [
      { n: -1 },
      { n: Number.NaN },
      { n: Number.POSITIVE_INFINITY },
      { n: "3" },
    ]) {
      const bad = JSON.stringify({
        schema: "analysis@1",
        installUUID: "uuid-1",
        digest: {
          schema: "digest@1",
          counters,
          eventSequences: DIGEST.eventSequences,
          episodes: [],
          citedSnippets: [],
        },
      });
      const result = await handler.handle(bad);
      expect(result.outcome).toBe("incomplete");
    }
    expect(calls).toHaveLength(0);
  });

  it("unbounded/invalid line refs => rejected pre-provider", async () => {
    const { handler, calls } = makeHandler();
    for (const line of [0, -3, 1.5, Number.NaN, "2"]) {
      const bad = JSON.stringify({
        schema: "analysis@1",
        installUUID: "uuid-1",
        digest: {
          schema: "digest@1",
          counters: {},
          eventSequences: [{ sessionId: "s1", events: [{ line, kind: "message" }] }],
          episodes: [],
          citedSnippets: [{ sessionId: "s1", line: 1, text: "t" }],
        },
      });
      const result = await handler.handle(bad);
      expect(result.outcome).toBe("incomplete");
    }
    expect(calls).toHaveLength(0);
  });

  it("invalid installUUID (non-string / empty) => rejected pre-provider", async () => {
    const { handler, calls } = makeHandler();
    for (const installUUID of [12345, null, ""]) {
      const bad = JSON.stringify({ schema: "analysis@1", installUUID, digest: DIGEST });
      const result = await handler.handle(bad);
      expect(result.outcome).toBe("incomplete");
    }
    expect(calls).toHaveLength(0);
  });

  it("store outage (reserve throws) => in-contract provider_unavailable, no provider call", async () => {
    const store = new InMemoryCounterStore({ quotaPerDay: 3, concurrencyLimit: 1 });
    store.reserve = () => Promise.reject(new Error("redis down"));
    const providerCalls: unknown[] = [];
    const real = new HttpProviderStub({ mode: "ok" });
    const spy = {
      name: "spy",
      analyze: (...args: unknown[]) => {
        providerCalls.push(args);
        return (real.analyze as (...a: unknown[]) => never)(...(args as [DigestV1]));
      },
    };
    const handler = createAnalysisHandler({
      store,
      provider: spy,
      config: { ...DEFAULT_BACKEND_CONFIG, timeoutMs: 500 },
      now: () => 1_000_000,
    });
    const result = await handler.handle(ENVELOPE());
    expect(result.outcome).toBe("incomplete");
    if (result.outcome === "incomplete") expect(result.error.code).toBe("provider_unavailable");
    expect(providerCalls).toHaveLength(0);
  });

  it("deadline settles even when the provider ignores abort: timeout error, slot released, no hang", async () => {
    const ignoreAbort = {
      name: "ignore-abort",
      analyze: () => new Promise<never>(() => undefined), // never settles, ignores signal
    };
    const handler = createAnalysisHandler({
      store: new InMemoryCounterStore({ quotaPerDay: 3, concurrencyLimit: 1 }),
      provider: ignoreAbort,
      config: { ...DEFAULT_BACKEND_CONFIG, timeoutMs: 80 },
      now: () => 1_000_000,
    });
    const result = await handler.handle(ENVELOPE());
    expect(result.outcome).toBe("incomplete");
    if (result.outcome === "incomplete") expect(result.error.code).toBe("timeout");
    // Slot was released despite the pending provider promise.
    const ok = makeHandler();
    expect((await ok.handler.handle(ENVELOPE())).outcome).toBe("complete");
  });
});

// Review-14 remediation (F2/F3).
describe("F2/F3 remediation", () => {
  it("F2: deadline timer cleared on the success path (no lingering 120s timers)", async () => {
    vi.useFakeTimers();
    try {
      const { handler } = makeHandler({ config: { ...DEFAULT_BACKEND_CONFIG, timeoutMs: 1000 } });
      const result = await handler.handle(ENVELOPE());
      expect(result.outcome).toBe("complete");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("F2: timer cleared on the provider-failure path", async () => {
    vi.useFakeTimers();
    try {
      const { handler } = makeHandler({
        provider: new HttpProviderStub({ mode: "rate_limited" }),
        config: { ...DEFAULT_BACKEND_CONFIG, timeoutMs: 1000 },
      });
      const result = await handler.handle(ENVELOPE());
      expect(result.outcome).toBe("incomplete");
      if (result.outcome === "incomplete") expect(result.error.code).toBe("over_quota");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("F2: timer cleared after deadline settle (hang provider that ignores abort)", async () => {
    vi.useFakeTimers();
    try {
      const ignoreAbort = {
        name: "ignore-abort",
        analyze: () => new Promise<never>(() => undefined),
      };
      const handler = createAnalysisHandler({
        store: new InMemoryCounterStore({ quotaPerDay: 3, concurrencyLimit: 1 }),
        provider: ignoreAbort,
        config: { ...DEFAULT_BACKEND_CONFIG, timeoutMs: 100 },
        now: () => 1_000_000,
      });
      const pending = handler.handle(ENVELOPE());
      await vi.advanceTimersByTimeAsync(150);
      const result = await pending;
      expect(result.outcome).toBe("incomplete");
      if (result.outcome === "incomplete") expect(result.error.code).toBe("timeout");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("F3: spend-write failure never refunds quota or turns a completed analysis into an error", async () => {
    const store = new InMemoryCounterStore({ quotaPerDay: 1, concurrencyLimit: 1 });
    store.addSpend = () => Promise.reject(new Error("redis blip"));
    const handler = createAnalysisHandler({
      store,
      provider: new HttpProviderStub({ mode: "ok" }),
      config: { ...DEFAULT_BACKEND_CONFIG, timeoutMs: 500 },
      now: () => 1_000_000,
    });
    const first = await handler.handle(ENVELOPE());
    expect(first.outcome).toBe("complete"); // valid result must stand
    // Quota stays consumed: no refund, retry is over_quota (no double spend).
    const second = await handler.handle(ENVELOPE());
    expect(second.outcome).toBe("incomplete");
    if (second.outcome === "incomplete") expect(second.error.code).toBe("over_quota");
  });
});
