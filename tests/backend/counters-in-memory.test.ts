import { describe, expect, it } from "vitest";
import { InMemoryCounterStore } from "../../src/backend/counters/in-memory.js";
import type { ReserveInput } from "../../src/backend/types.js";

const BASE: Omit<ReserveInput, "installUUID"> = {
  utcDay: "2026-09-07",
  now: 1_000_000,
  reservationTtlMs: 5_000,
};

function input(uuid = "uuid-a"): ReserveInput {
  return { ...BASE, installUUID: uuid };
}

describe("InMemoryCounterStore (atomic reserve/release)", () => {
  it("10 concurrent reserves for one install admit exactly 3 (quota 3/day)", async () => {
    const store = new InMemoryCounterStore({ quotaPerDay: 3, concurrencyLimit: 100 });
    const results = await Promise.all(Array.from({ length: 10 }, () => store.reserve(input())));
    const admitted = results.filter((r) => r.ok);
    expect(admitted).toHaveLength(3);
    const rejected = results.filter((r) => !r.ok);
    expect(rejected.every((r) => r.ok === false && r.reason === "quota")).toBe(true);
  });

  it("global concurrency limit 1 admits exactly 1 across distinct installs", async () => {
    const store = new InMemoryCounterStore({ quotaPerDay: 100, concurrencyLimit: 1 });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => store.reserve(input(`uuid-${i}`))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const busy = results.filter((r) => !r.ok);
    expect(busy.every((r) => r.ok === false && r.reason === "concurrency")).toBe(true);
  });

  it("second install while slot held is concurrency-rejected; after release it proceeds", async () => {
    const store = new InMemoryCounterStore({ quotaPerDay: 3, concurrencyLimit: 1 });
    const first = await store.reserve(input("uuid-a"));
    expect(first.ok).toBe(true);
    const second = await store.reserve(input("uuid-b"));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("concurrency");
    if (first.ok) await first.reservation.releaseConcurrency();
    const retry = await store.reserve(input("uuid-b"));
    expect(retry.ok).toBe(true);
  });

  it("failure path releases BOTH quota and concurrency slots (no leaked reservations)", async () => {
    const store = new InMemoryCounterStore({ quotaPerDay: 3, concurrencyLimit: 1 });
    const first = await store.reserve(input("uuid-a"));
    expect(first.ok).toBe(true);
    if (first.ok) await first.reservation.release(); // simulate provider failure
    const next = await store.reserve(input("uuid-a"));
    expect(next.ok).toBe(true);
    if (next.ok) await next.reservation.releaseConcurrency(); // success: quota stays
    // Quota used = 1, so 2 more fit; global concurrency admits exactly 1.
    const more = await Promise.all([
      store.reserve(input("uuid-a")),
      store.reserve(input("uuid-a")),
      store.reserve(input("uuid-a")),
    ]);
    expect(more.filter((r) => r.ok)).toHaveLength(1);
    const winner = more.find((r) => r.ok);
    if (winner?.ok) await winner.reservation.release(); // failure releases both
    const afterFailure = await store.reserve(input("uuid-a"));
    expect(afterFailure.ok).toBe(true); // the failed slot was fully returned
    if (afterFailure.ok) await afterFailure.reservation.releaseConcurrency();
    // Quota now 2/3 consumed by successes; the 3rd success fits, the 4th does not.
    const third = await store.reserve(input("uuid-a"));
    expect(third.ok).toBe(true);
    if (third.ok) await third.reservation.releaseConcurrency();
    const fourth = await store.reserve(input("uuid-a"));
    expect(fourth.ok).toBe(false); // quota 3/3 consumed by successes only
    if (!fourth.ok) expect(fourth.reason).toBe("quota");
  });

  it("success keeps the quota slot consumed; concurrency slot released", async () => {
    const store = new InMemoryCounterStore({ quotaPerDay: 3, concurrencyLimit: 1 });
    const first = await store.reserve(input("uuid-a"));
    if (!first.ok) throw new Error("expected reserve ok");
    await first.reservation.releaseConcurrency(); // success: only concurrency released
    const second = await store.reserve(input("uuid-a"));
    expect(second.ok).toBe(true);
    if (second.ok) await second.reservation.releaseConcurrency();
    const third = await store.reserve(input("uuid-a"));
    expect(third.ok).toBe(true);
    if (third.ok) await third.reservation.releaseConcurrency();
    const fourth = await store.reserve(input("uuid-a"));
    expect(fourth.ok).toBe(false);
    if (!fourth.ok) expect(fourth.reason).toBe("quota");
  });

  it("UTC day rollover resets the quota bucket", async () => {
    const store = new InMemoryCounterStore({ quotaPerDay: 1, concurrencyLimit: 10 });
    const day1 = await store.reserve({ ...BASE, installUUID: "uuid-a" });
    expect(day1.ok).toBe(true);
    const day1again = await store.reserve({ ...BASE, installUUID: "uuid-a" });
    expect(day1again.ok).toBe(false);
    const nextDay = await store.reserve({
      installUUID: "uuid-a",
      utcDay: "2026-09-08",
      now: BASE.now + 24 * 60 * 60 * 1000,
      reservationTtlMs: BASE.reservationTtlMs,
    });
    expect(nextDay.ok).toBe(true);
  });

  it("TTL expiry frees an abandoned concurrency reservation", async () => {
    const store = new InMemoryCounterStore({ quotaPerDay: 10, concurrencyLimit: 1 });
    const first = await store.reserve(input("uuid-a"));
    expect(first.ok).toBe(true);
    // No release (simulated crash); TTL passes.
    const later = await store.reserve({ ...input("uuid-b"), now: BASE.now + 6_000 });
    expect(later.ok).toBe(true);
  });

  it("stores metadata only and tracks spend for the ceiling check", async () => {
    const store = new InMemoryCounterStore({ quotaPerDay: 3, concurrencyLimit: 1 });
    await store.addSpend(2, BASE.now);
    await store.addSpend(1, BASE.now);
    expect(await store.spendUnits(BASE.now)).toBe(3);
  });

  // Root-review regressions: release must be idempotent and lease-owned.
  it("late release of an expired reservation does not steal the live slot", async () => {
    const store = new InMemoryCounterStore({ quotaPerDay: 10, concurrencyLimit: 1 });
    const a = await store.reserve({ ...input("lease-a"), reservationTtlMs: 300 });
    expect(a.ok).toBe(true);
    // A's TTL expires; a new reservation takes the slot.
    const b = await store.reserve({ ...input("lease-b"), now: BASE.now + 400 });
    expect(b.ok).toBe(true);
    // A's late release must be a no-op against B's live slot.
    if (a.ok) await a.reservation.releaseConcurrency();
    const c = await store.reserve({ ...input("lease-c"), now: BASE.now + 500 });
    expect(c.ok).toBe(false); // B still holds the only global slot
    if (b.ok) await b.reservation.releaseConcurrency();
    const d = await store.reserve({ ...input("lease-c"), now: BASE.now + 600 });
    expect(d.ok).toBe(true);
  });

  it("double release (releaseConcurrency then release) decrements at most once", async () => {
    const store = new InMemoryCounterStore({ quotaPerDay: 10, concurrencyLimit: 2 });
    const a = await store.reserve(input("dr-a"));
    const b = await store.reserve(input("dr-b"));
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (a.ok) {
      await a.reservation.releaseConcurrency(); // frees exactly one slot
      await a.reservation.release(); // must NOT free b's slot too
    }
    const c = await store.reserve(input("dr-c"));
    expect(c.ok).toBe(true); // the one genuinely free slot
    const d = await store.reserve(input("dr-d"));
    expect(d.ok).toBe(false); // b + c hold both slots; double-release would admit d
  });

  it("historical quota leases expire at their UTC-day bound (bounded memory)", async () => {
    const store = new InMemoryCounterStore({ quotaPerDay: 10, concurrencyLimit: 10 });
    const a = await store.reserve({ ...input("hist-a"), now: BASE.now });
    expect(a.ok).toBe(true);
    expect(store.liveLeaseCount(BASE.now)).toBe(2); // 1 quota + 1 concurrency
    // Three days later both leases are past their bounds.
    const later = BASE.now + 3 * 24 * 60 * 60 * 1000;
    expect(store.liveLeaseCount(later)).toBe(0);
  });
});
