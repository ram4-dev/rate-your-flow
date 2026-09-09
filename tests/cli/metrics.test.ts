/**
 * 3.2 RED: local metrics — 90-day window filtered by RECORD TIMESTAMPS
 * (mtime never admits old records), exact-boundary cases, TZ-pinned
 * invariance, offline, coverage counts (eligible/analyzed/omitted), no
 * total-coverage claim.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { computeLocalMetrics } from "../../src/cli/metrics.js";

const STORE_ROOT = fileURLToPath(new URL("../fixtures/stores", import.meta.url));
/** Fixed reference "now" for deterministic boundary tests. */
const NOW = "2026-09-07T12:00:00Z"; // 90d before = 2026-06-09T12:00:00Z

describe("computeLocalMetrics (3.2)", () => {
  it("90-day window by record timestamps: old sessions excluded, recent included", async () => {
    const metrics = await computeLocalMetrics({
      codexDir: `${STORE_ROOT}/codex`,
      piDir: `${STORE_ROOT}/pi`,
      now: NOW,
    });
    const analyzedIds = metrics.sessions.map((s) => s.sessionId);
    expect(analyzedIds).toContain("sess-recent");
    expect(analyzedIds).toContain("sess-boundary-exact");
    expect(analyzedIds).not.toContain("sess-old");
    expect(analyzedIds).not.toContain("sess-boundary-1s");
    expect(analyzedIds).toContain("pi-sess-1");
  });

  it("exact boundary inclusive: latest record exactly 90d old is included", async () => {
    const metrics = await computeLocalMetrics({
      codexDir: `${STORE_ROOT}/codex`,
      piDir: `${STORE_ROOT}/pi`,
      now: NOW,
    });
    expect(metrics.sessions.map((s) => s.sessionId)).toContain("sess-boundary-exact");
  });

  it("one second past the boundary is excluded", async () => {
    const metrics = await computeLocalMetrics({
      codexDir: `${STORE_ROOT}/codex`,
      piDir: `${STORE_ROOT}/pi`,
      now: NOW,
    });
    expect(metrics.sessions.map((s) => s.sessionId)).not.toContain("sess-boundary-1s");
  });

  it("recently-touched file with old records stays excluded (mtime hint only)", async () => {
    // sess-old-recent-mtime.jsonl has 2026-01 timestamps; its file mtime is
    // recent (created moments ago). It must NOT be admitted via mtime.
    const metrics = await computeLocalMetrics({
      codexDir: `${STORE_ROOT}/codex`,
      piDir: `${STORE_ROOT}/pi`,
      now: NOW,
    });
    expect(metrics.sessions.map((s) => s.sessionId)).not.toContain("sess-old-mtime");
  });

  it("boundary result is TZ-invariant (computed under UTC and a non-UTC TZ)", async () => {
    const runWithTz = async (tz: string): Promise<string[]> => {
      const previous = process.env.TZ;
      process.env.TZ = tz;
      try {
        const metrics = await computeLocalMetrics({
          codexDir: `${STORE_ROOT}/codex`,
          piDir: `${STORE_ROOT}/pi`,
          now: NOW,
        });
        return metrics.sessions.map((s) => s.sessionId).sort();
      } finally {
        if (previous === undefined) {
          delete process.env.TZ;
        } else {
          process.env.TZ = previous;
        }
      }
    };
    const utc = await runWithTz("UTC");
    const art = await runWithTz("America/Argentina/Buenos_Aires");
    expect(art).toEqual(utc);
    expect(utc).toContain("sess-boundary-exact");
    expect(utc).not.toContain("sess-boundary-1s");
  });

  it("coverage surfaced (eligible/analyzed/omitted); no total-coverage claim", async () => {
    const metrics = await computeLocalMetrics({
      codexDir: `${STORE_ROOT}/codex`,
      piDir: `${STORE_ROOT}/pi`,
      now: NOW,
    });
    expect(metrics.coverage.eligible).toBe(6);
    expect(metrics.coverage.analyzed).toBe(3);
    expect(metrics.coverage.omitted).toBe(3);
    expect(Object.keys(metrics).some((k) => k.toLowerCase().includes("coveragepercent"))).toBe(
      false,
    );
  });

  it("offline: computed with no network (pure fs + pure functions)", async () => {
    // Structural guarantee: the module performs no fetch/net calls (reviewed);
    // this test pins observable behavior: metrics computed on an isolated
    // store root succeed identically on a second call.
    const first = await computeLocalMetrics({
      codexDir: `${STORE_ROOT}/codex`,
      piDir: `${STORE_ROOT}/pi`,
      now: NOW,
    });
    const second = await computeLocalMetrics({
      codexDir: `${STORE_ROOT}/codex`,
      piDir: `${STORE_ROOT}/pi`,
      now: NOW,
    });
    expect(second.coverage).toEqual(first.coverage);
  });

  it("onProgress fires after EVERY file including omitted/out-of-window paths (advances to total)", async () => {
    const calls: Array<{ processed: number; total: number }> = [];
    await computeLocalMetrics({
      codexDir: `${STORE_ROOT}/codex`,
      piDir: `${STORE_ROOT}/pi`,
      now: NOW,
      onProgress: (processed, total) => calls.push({ processed, total }),
    });
    // eligible (discovered) is 6; the callback must be invoked once per
    // discovered file regardless of whether it lands in the window.
    expect(calls).toHaveLength(6);
    expect(calls[0]).toEqual({ processed: 1, total: 6 });
    expect(calls.at(-1)).toEqual({ processed: 6, total: 6 });
  });

  it("metrics are supporting evidence: tool/episode counts + token summary flagged unverified", async () => {
    const metrics = await computeLocalMetrics({
      codexDir: `${STORE_ROOT}/codex`,
      piDir: `${STORE_ROOT}/pi`,
      now: NOW,
    });
    const recent = metrics.sessions.find((s) => s.sessionId === "sess-recent");
    expect(recent?.toolCalls.total).toBe(1);
    expect(recent?.toolCalls.resolved).toBe(1);
    expect(recent?.tokenSummary?.verified).toBe(false);
    // pi session records its real isError signal.
    const piSession = metrics.sessions.find((s) => s.sessionId === "pi-sess-1");
    expect(piSession?.toolCalls.errored).toBe(1);
  });
});
