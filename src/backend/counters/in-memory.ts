/**
 * InMemoryCounterStore — single-instance counter store (design D3).
 *
 * Lease-based: every reservation owns unique lease IDs; release is
 * lease-owned and idempotent (a late release after TTL expiry is a no-op and
 * can never steal a live slot). Quota leases expire at the next UTC day;
 * concurrency leases at reserve+reservationTtlMs — historical days are
 * bounded, never held with an unbounded expiry. Single-threaded JS makes the
 * check+write a critical section without awaits. Metadata only.
 */

import { randomUUID } from "node:crypto";
import { utcMsUntilNextDay } from "../config.js";
import type { CounterReservation, CounterStore, ReserveInput, ReserveOutcome } from "../types.js";

export interface InMemoryCounterStoreOptions {
  quotaPerDay: number;
  concurrencyLimit: number;
}

interface Lease {
  quotaKey: string;
  quotaExpiresAt: number;
  concExpiresAt: number;
  /** Nulled once that part is released; release on a nulled part is a no-op. */
  quotaReleased: boolean;
  concReleased: boolean;
}

export class InMemoryCounterStore implements CounterStore {
  readonly #quotaPerDay: number;
  readonly #concurrencyLimit: number;
  /** Key: `${installUUID}|${utcDay}` → live quota leases. */
  readonly #quotaLeases: Map<string, Map<string, Lease>> = new Map();
  /** Lease ID → live concurrency lease (global limit). */
  readonly #concLeases: Map<string, Lease> = new Map();
  #spendUnits = 0;
  #spendExpiresAt = 0;

  constructor(options: InMemoryCounterStoreOptions) {
    this.#quotaPerDay = options.quotaPerDay;
    this.#concurrencyLimit = options.concurrencyLimit;
  }

  /** Observability/metadata only: count of live (unexpired) leases. */
  liveLeaseCount(now: number): number {
    let count = 0;
    for (const lease of this.#concLeases.values()) {
      if (lease.concExpiresAt > now && !lease.concReleased) count += 1;
    }
    for (const leases of this.#quotaLeases.values()) {
      for (const lease of leases.values()) {
        if (lease.quotaExpiresAt > now && !lease.quotaReleased) count += 1;
      }
    }
    return count;
  }

  async reserve(input: ReserveInput): Promise<ReserveOutcome> {
    const { installUUID, utcDay: day, now, reservationTtlMs } = input;
    this.#purgeExpired(now);

    const quotaKey = `${installUUID}|${day}`;
    const quotaUsed = this.#quotaLeases.get(quotaKey)?.size ?? 0;
    if (quotaUsed >= this.#quotaPerDay) return { ok: false, reason: "quota" };

    const concUsed = this.#concLeases.size;
    if (concUsed >= this.#concurrencyLimit) return { ok: false, reason: "concurrency" };

    // Atomic critical section (no await between checks and writes).
    const lease: Lease = {
      quotaKey,
      quotaExpiresAt: now + utcMsUntilNextDay(now),
      concExpiresAt: now + reservationTtlMs,
      quotaReleased: false,
      concReleased: false,
    };
    const id = randomUUID();
    this.#concLeases.set(id, lease);
    let bucket = this.#quotaLeases.get(quotaKey);
    if (bucket === undefined) {
      bucket = new Map();
      this.#quotaLeases.set(quotaKey, bucket);
    }
    bucket.set(id, lease);

    return { ok: true, reservation: this.#reservation(id, quotaKey, lease) };
  }

  async spendUnits(now: number): Promise<number> {
    if (this.#spendExpiresAt <= now) this.#spendUnits = 0;
    return this.#spendUnits;
  }

  async addSpend(units: number, now: number): Promise<void> {
    if (this.#spendExpiresAt <= now) this.#spendUnits = 0;
    this.#spendUnits += units;
    // Monthly-ish TTL refreshed on write (operator proposal; ceiling defaults
    // to disabled).
    this.#spendExpiresAt = now + 31 * 24 * 60 * 60 * 1000;
  }

  /** Drop expired leases so historical days/slots cannot accumulate. */
  #purgeExpired(now: number): void {
    for (const [id, lease] of this.#concLeases) {
      if (lease.concExpiresAt <= now) this.#concLeases.delete(id);
    }
    for (const [quotaKey, leases] of this.#quotaLeases) {
      for (const [id, lease] of leases) {
        if (lease.quotaExpiresAt <= now) leases.delete(id);
      }
      if (leases.size === 0) this.#quotaLeases.delete(quotaKey);
    }
  }

  #reservation(id: string, quotaKey: string, lease: Lease): CounterReservation {
    const releaseConcurrency = async (): Promise<void> => {
      if (lease.concReleased) return; // idempotent + owned
      lease.concReleased = true;
      this.#concLeases.delete(id);
    };
    const releaseQuota = async (): Promise<void> => {
      if (lease.quotaReleased) return;
      lease.quotaReleased = true;
      this.#quotaLeases.get(quotaKey)?.delete(id);
    };
    return {
      releaseConcurrency,
      releaseQuota,
      release: async () => {
        await releaseConcurrency();
        await releaseQuota();
      },
    };
  }
}
