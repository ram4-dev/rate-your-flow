import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_BACKEND_CONFIG } from "../../src/backend/config.js";
import { createAnalysisHandler } from "../../src/backend/handler.js";
import { SharedCounterStore } from "../../src/backend/counters/shared.js";
import { HttpProviderStub } from "../../src/backend/providers/stub.js";
import type { DigestV1 } from "../../src/shared/contracts/index.js";

/**
 * Two service instances sharing Redis (design D3; spec "Atomic shared
 * counters"): real Redis at 127.0.0.1:32768 (container ryf-sdd-redis), unique
 * per-run prefix, NO FLUSHALL — cleanup deletes only this run's keys.
 */

const REDIS_URL = process.env.RYF_TEST_REDIS_URL ?? "redis://127.0.0.1:32768";
const PREFIX = `ryf:test:int:${randomUUID()}:`;

const DIGEST: DigestV1 = {
  schema: "digest@1",
  counters: { sessions: 1 },
  eventSequences: [{ sessionId: "s1", events: [{ line: 1, kind: "message" }] }],
  episodes: [],
  citedSnippets: [{ sessionId: "s1", line: 1, text: "evidence" }],
};

const envelope = (uuid: string): string =>
  JSON.stringify({ schema: "analysis@1", installUUID: uuid, digest: DIGEST });

function makeInstance(
  providerMode: "ok" | "rate_limited" | "payment_required" | "hang" | "invalid",
  providerDelayMs?: number,
) {
  const store = new SharedCounterStore({
    url: REDIS_URL,
    keyPrefix: PREFIX,
    quotaPerDay: 3,
    concurrencyLimit: 1,
  });
  const stubOptions = {
    mode: providerMode,
    ...(providerDelayMs !== undefined ? { delayMs: providerDelayMs } : {}),
  };
  const handler = createAnalysisHandler({
    store,
    provider: new HttpProviderStub(stubOptions),
    config: { ...DEFAULT_BACKEND_CONFIG, timeoutMs: 400 },
  });
  return { store, handler };
}

const instances: Array<{ store: SharedCounterStore }> = [];
function track<T extends { store: SharedCounterStore }>(built: T): T {
  instances.push({ store: built.store });
  return built;
}

afterAll(async () => {
  for (const { store } of instances) await store.purgeOwnKeys();
  for (const { store } of instances) await store.close();
});

describe("two service instances sharing Redis (cross-instance contract)", () => {
  it("daily quota 3 is global across instances; 4th rejected as over_quota", async () => {
    const a = track(makeInstance("ok"));
    const b = track(makeInstance("ok"));
    const outcomes = [];
    for (const instance of [a, b, a]) {
      outcomes.push((await instance.handler.handle(envelope("quota-uuid"))).outcome);
    }
    expect(outcomes).toEqual(["complete", "complete", "complete"]);
    const fourth = await b.handler.handle(envelope("quota-uuid"));
    expect(fourth.outcome).toBe("incomplete");
    if (fourth.outcome === "incomplete") expect(fourth.error.code).toBe("over_quota");
  });

  it("global concurrency 1 across instances: second in-flight rejected, freed after completion", async () => {
    const slow = track(makeInstance("ok", 250));
    const other = track(makeInstance("ok"));
    const [first, second] = await Promise.all([
      slow.handler.handle(envelope("conc-uuid-a")),
      other.handler.handle(envelope("conc-uuid-b")),
    ]);
    expect([first.outcome, second.outcome].sort()).toEqual(["complete", "incomplete"]);
    // After the slow request completes, the other instance can proceed.
    const after = await other.handler.handle(envelope("conc-uuid-b"));
    expect(after.outcome).toBe("complete");
  });

  it("failure release is cross-instance: provider error on A frees slots for B", async () => {
    const failing = track(makeInstance("rate_limited"));
    const healthy = track(makeInstance("ok"));
    const failed = await failing.handler.handle(envelope("rel-uuid"));
    expect(failed.outcome).toBe("incomplete");
    if (failed.outcome === "incomplete") {
      expect(failed.error.code).toBe("over_quota");
      expect(failed.error.retryAfterSeconds).toBe(45);
    }
    const next = await healthy.handler.handle(envelope("rel-uuid-2"));
    expect(next.outcome).toBe("complete");
  });

  it("402 maps to payment_required envelope across instances", async () => {
    const paywalled = track(makeInstance("payment_required"));
    const failed = await paywalled.handler.handle(envelope("pay-uuid"));
    expect(failed.outcome).toBe("incomplete");
    if (failed.outcome === "incomplete") expect(failed.error.code).toBe("payment_required");
  });

  it("provider timeout releases the global slot for the other instance", async () => {
    const hanging = track(makeInstance("hang"));
    const healthy = track(makeInstance("ok"));
    const timedOut = await hanging.handler.handle(envelope("to-uuid"));
    expect(timedOut.outcome).toBe("incomplete");
    if (timedOut.outcome === "incomplete") expect(timedOut.error.code).toBe("timeout");
    const next = await healthy.handler.handle(envelope("to-uuid-2"));
    expect(next.outcome).toBe("complete");
  });

  it("UTC day rollover resets the shared per-install quota", async () => {
    const store = new SharedCounterStore({
      url: REDIS_URL,
      keyPrefix: PREFIX,
      quotaPerDay: 1,
      concurrencyLimit: 10,
    });
    instances.push({ store });
    const day1 = Date.parse("2026-09-07T12:00:00Z");
    // First handler with fixed now for day1.
    const day1Handler = createAnalysisHandler({
      store,
      provider: new HttpProviderStub({ mode: "ok" }),
      config: { ...DEFAULT_BACKEND_CONFIG, timeoutMs: 400 },
      now: () => day1,
    });
    const first = await day1Handler.handle(envelope("roll-uuid"));
    expect(first.outcome).toBe("complete");
    const second = await day1Handler.handle(envelope("roll-uuid"));
    expect(second.outcome).toBe("incomplete"); // quota 1/day exhausted for day1
    // Next UTC day: fresh bucket (handler with day2 now).
    const day2Handler = createAnalysisHandler({
      store,
      provider: new HttpProviderStub({ mode: "ok" }),
      config: { ...DEFAULT_BACKEND_CONFIG, timeoutMs: 400 },
      now: () => day1 + 24 * 60 * 60 * 1000,
    });
    const nextDay = await day2Handler.handle(envelope("roll-uuid"));
    expect(nextDay.outcome).toBe("complete");
  });

  it("invalid provider output never leaks into the response envelope", async () => {
    const invalid = track(makeInstance("invalid"));
    const result = await invalid.handler.handle(envelope("inv-uuid"));
    expect(result.outcome).toBe("incomplete");
    if (result.outcome === "incomplete") expect(result.error.code).toBe("invalid_model_response");
  });
});
