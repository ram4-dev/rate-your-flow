import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { SharedCounterStore } from "../../src/backend/counters/shared.js";
import type { ReserveInput } from "../../src/backend/types.js";
import type { SharedCounterStoreOptions } from "../../src/backend/counters/shared.js";

/**
 * Real two-instance Redis integration (design D3, spec "Atomic shared
 * counters"): Redis at 127.0.0.1:32768 (container ryf-sdd-redis). Unique
 * per-test key prefix; NEVER FLUSHALL — cleanup only deletes keys under the
 * test's own prefix via purgeOwnKeys (SCAN+DEL).
 */

const REDIS_URL = process.env.RYF_TEST_REDIS_URL ?? "redis://127.0.0.1:32768";

const BASE: Omit<ReserveInput, "installUUID"> = {
  utcDay: "2026-09-07",
  now: 1_000_000,
  reservationTtlMs: 5_000,
};

const allStores: SharedCounterStore[] = [];

function makePair(options: Pick<SharedCounterStoreOptions, "quotaPerDay" | "concurrencyLimit">): {
  a: SharedCounterStore;
  b: SharedCounterStore;
  prefix: string;
} {
  const prefix = `ryf:test:${randomUUID()}:`;
  const make = (): SharedCounterStore => {
    const store = new SharedCounterStore({ url: REDIS_URL, keyPrefix: prefix, ...options });
    allStores.push(store);
    return store;
  };
  return { a: make(), b: make(), prefix };
}

function input(prefix: string, uuid: string): ReserveInput {
  return { ...BASE, installUUID: `${prefix}${uuid}` };
}

afterAll(async () => {
  for (const store of allStores) await store.purgeOwnKeys();
  for (const store of allStores) await store.close();
});

describe("SharedCounterStore (real Redis, two instances)", () => {
  it("atomic reserve: 10 concurrent claims across 2 instances admit exactly 3 (quota 3/day)", async () => {
    const { a, b, prefix } = makePair({ quotaPerDay: 3, concurrencyLimit: 100 });
    // Same install for all claims: one shared per-install daily bucket.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        (i % 2 === 0 ? a : b).reserve(input(prefix, "shared-uuid")),
      ),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "quota")).toBe(true);
    for (const r of results) if (r.ok) await r.reservation.releaseQuota();
  });

  it("atomic reserve: 10 concurrent claims across 2 instances admit exactly 1 (concurrency 1)", async () => {
    const { a, b, prefix } = makePair({ quotaPerDay: 100, concurrencyLimit: 1 });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? a : b).reserve(input(prefix, `c${i}`))),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.reason === "concurrency")).toBe(
      true,
    );
    for (const r of results) if (r.ok) await r.reservation.release();
  });

  it("release on instance A frees the slot observed by instance B", async () => {
    const { a, b, prefix } = makePair({ quotaPerDay: 10, concurrencyLimit: 1 });
    const first = await a.reserve(input(prefix, "x1"));
    expect(first.ok).toBe(true);
    const second = await b.reserve(input(prefix, "x2"));
    expect(second.ok).toBe(false); // global slot held
    if (first.ok) await first.reservation.release(); // failure path: both
    const third = await b.reserve(input(prefix, "x2"));
    expect(third.ok).toBe(true);
    if (third.ok) await third.reservation.release();
  });

  it("quota reservation is per-install and per-UTC-day; released on failure", async () => {
    const { a, b, prefix } = makePair({ quotaPerDay: 3, concurrencyLimit: 100 });
    const first = await a.reserve(input(prefix, "d1"));
    expect(first.ok).toBe(true);
    const sameDay = await b.reserve(input(prefix, "d1x")); // distinct uuid => own bucket
    expect(sameDay.ok).toBe(true);
    const third = await a.reserve(input(prefix, "d1"));
    expect(third.ok).toBe(true);
    const fourth = await a.reserve(input(prefix, "d1"));
    expect(fourth.ok).toBe(true); // 3rd of 3/day for d1
    const fifth = await a.reserve(input(prefix, "d1"));
    expect(fifth.ok).toBe(false);
    if (!fifth.ok) expect(fifth.reason).toBe("quota");
    const nextDay = await a.reserve({ ...input(prefix, "d1"), utcDay: "2026-09-08" });
    expect(nextDay.ok).toBe(true); // UTC day rollover
    for (const r of [first, sameDay, third, nextDay]) if (r.ok) await r.reservation.releaseQuota();
  });

  it("TTL expiry frees an abandoned concurrency reservation", async () => {
    const { a, b, prefix } = makePair({ quotaPerDay: 10, concurrencyLimit: 1 });
    const first = await a.reserve({ ...input(prefix, "t1"), reservationTtlMs: 300 });
    expect(first.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    const second = await b.reserve({ ...input(prefix, "t2"), now: BASE.now + 500 });
    expect(second.ok).toBe(true);
    if (second.ok) await second.reservation.release();
  });

  it("late release of an expired reservation does not steal the live slot (lease-owned)", async () => {
    const { a, b, prefix } = makePair({ quotaPerDay: 10, concurrencyLimit: 1 });
    const expired = await a.reserve({ ...input(prefix, "l1"), reservationTtlMs: 300 });
    expect(expired.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 500)); // expired lease
    const live = await b.reserve({
      ...input(prefix, "l2"),
      now: BASE.now + 500,
      reservationTtlMs: 5_000,
    });
    expect(live.ok).toBe(true);
    if (expired.ok) await expired.reservation.releaseConcurrency(); // late release: no-op
    const third = await b.reserve(input(prefix, "l3"));
    expect(third.ok).toBe(false); // live lease still holds the only slot
    if (live.ok) await live.reservation.releaseConcurrency();
    const fourth = await b.reserve(input(prefix, "l3"));
    expect(fourth.ok).toBe(true);
    if (fourth.ok) await fourth.reservation.release();
  });

  it("double release (releaseConcurrency then release) decrements at most once", async () => {
    const { a, b, prefix } = makePair({ quotaPerDay: 100, concurrencyLimit: 2 });
    const first = await a.reserve(input(prefix, "dr-a"));
    const second = await b.reserve(input(prefix, "dr-b"));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok) {
      await first.reservation.releaseConcurrency(); // frees exactly one slot
      await first.reservation.release(); // must NOT free second's slot too
    }
    const third = await b.reserve(input(prefix, "dr-c"));
    expect(third.ok).toBe(true); // the one genuinely free slot
    const fourth = await b.reserve(input(prefix, "dr-d"));
    expect(fourth.ok).toBe(false); // slots held: dr-b + dr-c
  });

  it("spend counters are shared and metadata-only (numeric GET under prefix)", async () => {
    const { a, b } = makePair({ quotaPerDay: 10, concurrencyLimit: 10 });
    await a.addSpend(2, BASE.now);
    await b.addSpend(3, BASE.now);
    expect(await b.spendUnits(BASE.now)).toBe(5);
  });

  it("purgeOwnKeys deletes only keys under its own prefix", async () => {
    const { a, prefix } = makePair({ quotaPerDay: 10, concurrencyLimit: 10 });
    const reserved = await a.reserve(input(prefix, "p1"));
    expect(reserved.ok).toBe(true);
    const deleted = await a.purgeOwnKeys();
    expect(deleted).toBeGreaterThan(0);
    // After purge, the slot is gone even without release.
    const again = await a.reserve(input(prefix, "p1"));
    expect(again.ok).toBe(true);
    if (again.ok) await again.reservation.release();
  });
});
