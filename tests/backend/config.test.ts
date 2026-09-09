import { describe, expect, it } from "vitest";
import { utcDay, utcMsUntilNextDay } from "../../src/backend/config.js";
import { DEFAULT_BACKEND_CONFIG, type BackendConfig } from "../../src/backend/config.js";

describe("backend operator config", () => {
  it("defaults: quota 3/day, 1 concurrent, 120s timeout, ceiling disabled", () => {
    expect(DEFAULT_BACKEND_CONFIG.quotaPerDay).toBe(3);
    expect(DEFAULT_BACKEND_CONFIG.concurrencyLimit).toBe(1);
    expect(DEFAULT_BACKEND_CONFIG.timeoutMs).toBe(120_000);
    expect(DEFAULT_BACKEND_CONFIG.costCeiling.enabled).toBe(false);
    // Injectable in tests: tests override timeoutMs (e.g. 50ms), never the default.
    const test: BackendConfig = { ...DEFAULT_BACKEND_CONFIG, timeoutMs: 50 };
    expect(test.timeoutMs).toBe(50);
    expect(DEFAULT_BACKEND_CONFIG.timeoutMs).toBe(120_000);
  });

  it("utcDay is the UTC calendar day string", () => {
    // 2026-09-07T23:30:00Z is UTC day 2026-09-07 regardless of local TZ.
    expect(utcDay(Date.parse("2026-09-07T23:30:00Z"))).toBe("2026-09-07");
    // One second later in UTC terms it is still the same UTC day at 23:59:59.5,
    // and flips at midnight UTC.
    expect(utcDay(Date.parse("2026-09-08T00:00:00Z"))).toBe("2026-09-08");
  });

  it("utcMsUntilNextDay measures the gap to UTC midnight", () => {
    const at = Date.parse("2026-09-07T23:59:59.000Z");
    expect(utcMsUntilNextDay(at)).toBe(1000);
    const midnight = Date.parse("2026-09-08T00:00:00.000Z");
    expect(utcMsUntilNextDay(midnight)).toBe(24 * 60 * 60 * 1000);
  });
});
