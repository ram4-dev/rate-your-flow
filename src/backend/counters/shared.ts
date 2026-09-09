/**
 * SharedCounterStore — Redis-backed multi-instance counter store (design D3).
 *
 * Uses the maintained `redis` npm client (no bespoke RESP parsing).
 *
 * Lease ownership: every reservation owns a unique leaseId. Concurrency is a
 * sorted set of active leases scored by expiry epoch-ms: reserve purges
 * expired members (ZREMRANGEBYSCORE), counts live members (ZCARD) and adds
 * its lease (ZADD), so orphaned/crashed leases expire out of the count even
 * with limit > 1 and stale counts are impossible. Release = ZREM(own lease)
 * — idempotent, and a late release after expiry never steals a live slot.
 * Quota is a per-install/UTC-day counter guarded by a TTL lease key; failure
 * paths release it. Atomicity via Lua (EVAL). Unique key prefix; NEVER
 * FLUSHALL — `purgeOwnKeys` (test/maintenance) SCAN+DELs only this store's
 * own prefix. Metadata only — never digest content.
 */

import { randomUUID } from "node:crypto";
import { createClient, type RedisClientType } from "redis";
import { utcMsUntilNextDay } from "../config.js";
import type { CounterReservation, CounterStore, ReserveInput, ReserveOutcome } from "../types.js";

export interface SharedCounterStoreOptions {
  /** redis://host:port */
  url: string;
  /** Unique key prefix; every key this store touches lives under it. */
  keyPrefix: string;
  quotaPerDay: number;
  concurrencyLimit: number;
}

/**
 * Lua: atomic reserve. Concurrency ZSET member = leaseId, score = expiry ms.
 * ARGV: [1] quotaMax, [2] concLimit, [3] nowMs (purge bound, exclusive of
 * live leases), [4] leaseId, [5] concExpiryMs, [6] quotaLeaseTtlMs,
 * [7] concCleanupTtlMs, [8] quotaCounterTtlMs.
 * KEYS: [1] quota counter, [2] conc zset, [3] quota lease key.
 */
const RESERVE_LUA = `
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[3])
local c = tonumber(redis.call('ZCARD', KEYS[2]))
if c >= tonumber(ARGV[2]) then return {0, 2} end
local q = tonumber(redis.call('GET', KEYS[1]) or '0')
if q >= tonumber(ARGV[1]) then return {0, 1} end
redis.call('ZADD', KEYS[2], ARGV[5], ARGV[4])
redis.call('INCR', KEYS[1])
redis.call('SET', KEYS[3], '1', 'PX', ARGV[6])
redis.call('PEXPIRE', KEYS[1], ARGV[8])
redis.call('PEXPIRE', KEYS[2], ARGV[7])
return {1, 0}
`;

/**
 * Lua: release owned leases only. Concurrency = ZREM of own leaseId
 * (KEYS[2]); quota released only when ARGV[1] == '1' and the quota lease
 * key (KEYS[3]) is still live. Missing lease/expired member ⇒ no-op.
 * ARGV: [1] releaseQuota, [2] leaseId.
 */
const RELEASE_LUA = `
local released = 0
if redis.call('ZREM', KEYS[2], ARGV[2]) == 1 then released = 1 end
if ARGV[1] == '1' and redis.call('EXISTS', KEYS[3]) == 1 then
  redis.call('DEL', KEYS[3])
  local q = tonumber(redis.call('GET', KEYS[1]) or '0')
  if q <= 1 then redis.call('DEL', KEYS[1]) else redis.call('DECR', KEYS[1]) end
  released = 1
end
return released
`;

/** Lua: release only the quota lease (quota-only release path). */
const QUOTA_RELEASE_LUA = `
if redis.call('EXISTS', KEYS[2]) == 1 then
  redis.call('DEL', KEYS[2])
  local q = tonumber(redis.call('GET', KEYS[1]) or '0')
  if q <= 1 then redis.call('DEL', KEYS[1]) else redis.call('DECR', KEYS[1]) end
  return 1
end
return 0
`;

/** Lua: INCRBY the spend bucket with a monthly-ish TTL. */
const SPEND_LUA = `
if redis.call('TTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
return redis.call('INCRBY', KEYS[1], ARGV[1])
`;

export class SharedCounterStore implements CounterStore {
  private readonly client: RedisClientType;
  private readonly prefix: string;
  private readonly quotaPerDay: number;
  private readonly concurrencyLimit: number;
  private connected = false;

  constructor(options: SharedCounterStoreOptions) {
    this.prefix = options.keyPrefix;
    this.quotaPerDay = options.quotaPerDay;
    this.concurrencyLimit = options.concurrencyLimit;
    this.client = createClient({ url: options.url });
  }

  private connectPromise: Promise<void> | null = null;

  private ensureConnected(): Promise<void> {
    if (this.connected) return Promise.resolve();
    // Single in-flight connect: concurrent callers share one promise.
    if (this.connectPromise === null) {
      this.connectPromise = this.client
        .connect()
        .then(() => {
          this.connected = true;
        })
        .catch((error: unknown) => {
          this.connectPromise = null;
          throw error;
        });
    }
    return this.connectPromise;
  }

  async reserve(input: ReserveInput): Promise<ReserveOutcome> {
    await this.ensureConnected();
    const leaseId = randomUUID();
    const quotaKey = `${this.prefix}quota:${input.utcDay}:${input.installUUID}`;
    const concKey = `${this.prefix}conc:global`;
    const quotaLeaseKey = `${this.prefix}qlease:${leaseId}`;
    const quotaTtlMs = utcMsUntilNextDay(input.now) + 60_000;
    const concExpiresAt = input.now + input.reservationTtlMs;
    const reserveReply = (await this.client.eval(RESERVE_LUA, {
      keys: [quotaKey, concKey, quotaLeaseKey],
      arguments: [
        String(this.quotaPerDay),
        String(this.concurrencyLimit),
        String(input.now), // purge bound: members with score <= now are expired
        leaseId,
        String(concExpiresAt), // ZSET score = expiry epoch ms
        String(quotaTtlMs),
        String(quotaTtlMs),
        String(quotaTtlMs),
      ],
    })) as number[];
    const [ok, reason] = reserveReply;
    if (ok === 1) {
      const releaseWith = (releaseQuota: boolean): Promise<void> =>
        this.client
          .eval(RELEASE_LUA, {
            keys: [quotaKey, concKey, quotaLeaseKey],
            arguments: [releaseQuota ? "1" : "0", leaseId],
          })
          .then(() => undefined);
      const reservation: CounterReservation = {
        releaseConcurrency: async () => {
          await releaseWith(false);
        },
        releaseQuota: async () => {
          await this.client
            .eval(QUOTA_RELEASE_LUA, { keys: [quotaKey, quotaLeaseKey], arguments: [] })
            .then(() => undefined);
        },
        release: async () => {
          await releaseWith(true);
        },
      };
      return { ok: true, reservation };
    }
    return { ok: false, reason: reason === 2 ? "concurrency" : "quota" };
  }

  async spendUnits(now: number): Promise<number> {
    await this.ensureConnected();
    const month = new Date(now).toISOString().slice(0, 7);
    const reply = await this.client.get(`${this.prefix}spend:${month}`);
    return reply === null ? 0 : Number.parseInt(reply, 10);
  }

  async addSpend(units: number, now: number): Promise<void> {
    await this.ensureConnected();
    const month = new Date(now).toISOString().slice(0, 7);
    const ttl = 31 * 24 * 60 * 60 * 1000;
    await this.client.eval(SPEND_LUA, {
      keys: [`${this.prefix}spend:${month}`],
      arguments: [String(units), String(ttl)],
    });
  }

  /**
   * Delete every key under THIS store's own prefix (test/maintenance only).
   * SCAN + DEL — never FLUSHALL; other prefixes are untouched.
   */
  async purgeOwnKeys(): Promise<number> {
    await this.ensureConnected();
    let deleted = 0;
    // redis v6 scanIterator yields BATCHES (string[]), possibly empty.
    for await (const batch of this.client.scanIterator({
      MATCH: `${this.prefix}*`,
      COUNT: 100,
    })) {
      const keys = Array.isArray(batch) ? batch : [batch];
      if (keys.length > 0) deleted += await this.client.del(keys);
    }
    return deleted;
  }

  /** Close the underlying client (tests only). */
  async close(): Promise<void> {
    if (this.connected) {
      await this.client.quit();
      this.connected = false;
    }
  }
}
