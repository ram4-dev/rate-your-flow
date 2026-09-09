/**
 * 4.1/4.3 RED: digest@1 builder — versioned schema, bounded 48 KiB UTF-8
 * default budget (operator-overridable), deterministic ≤50-session latest
 * activity selection, redact-before-
 * finalize, preview identical to the payload that would be sent.
 */
import { describe, expect, it } from "vitest";
import {
  DIGEST_DEFAULT_BUDGET_BYTES,
  DIGEST_MAX_SESSIONS,
} from "../../src/shared/contracts/digest@1.js";
import { buildDigest, renderPreview } from "../../src/cli/digest.js";
import { redact } from "../../src/shared/redact.js";
import type { Session } from "../../src/cli/parsers/model.js";

function syntheticSession(id: string, ts: string, content: string): Session {
  const records = [
    { line: 1, type: "session_meta", timestamp: ts, payload: { id } },
    {
      line: 2,
      type: "response_item",
      timestamp: ts,
      payload: { type: "message", role: "user", content },
    },
    {
      line: 3,
      type: "response_item",
      timestamp: ts,
      payload: { type: "function_call", call_id: `${id}-c1`, name: "shell", arguments: "{}" },
    },
  ];
  return {
    source: "codex",
    sourceVersion: "codex@1",
    sessionId: id,
    filePath: `/tmp/${id}.jsonl`,
    records,
    episodes: [{ branchId: "main", events: records.slice(1), lineRefs: [2, 3] }],
    toolCalls: [{ callId: `${id}-c1`, name: "shell", resolved: false }],
    tokenEvents: [],
    warnings: [],
    latestRecordTimestamp: ts,
  };
}

describe("buildDigest (4.1/4.2)", () => {
  it("declares digest@1 with counters, event sequences, episodes, cited snippets", () => {
    const session = syntheticSession("s1", "2026-09-01T10:00:00Z", "please run the tests");
    const digest = buildDigest({
      sessions: [session],
      coverage: { eligible: 1, analyzed: 1, omitted: 0 },
    });
    expect(digest.schema).toBe("digest@1");
    expect(digest.counters["sessions"]).toBe(1);
    expect(digest.counters["toolCalls"]).toBe(1);
    expect(digest.eventSequences[0]?.sessionId).toBe("s1");
    expect(digest.eventSequences[0]?.events.length).toBeGreaterThan(0);
    expect(digest.episodes[0]?.sessionId).toBe("s1");
    const snippet = digest.citedSnippets[0];
    expect(snippet?.sessionId).toBe("s1");
    expect(typeof snippet?.line).toBe("number");
    expect(snippet?.text.length).toBeGreaterThan(0);
  });

  it("no full raw traces: snippet text is bounded, not the whole record dump", () => {
    const longContent = "x".repeat(5000);
    const session = syntheticSession("s-big", "2026-09-01T10:00:00Z", longContent);
    const digest = buildDigest({
      sessions: [session],
      coverage: { eligible: 1, analyzed: 1, omitted: 0 },
    });
    for (const snippet of digest.citedSnippets) {
      expect(snippet.text.length).toBeLessThanOrEqual(200);
      expect(snippet.text).not.toContain(longContent.slice(0, 400));
    }
  });

  it("budget enforced: serialized digest stays within the configured budget (48 KiB default)", () => {
    const sessions = Array.from({ length: 40 }, (_, i) =>
      syntheticSession(
        `s${i}`,
        `2026-09-01T10:00:${String(i % 60).padStart(2, "0")}Z`,
        "filler ".repeat(60),
      ),
    );
    const digest = buildDigest({
      sessions,
      coverage: { eligible: 40, analyzed: 40, omitted: 0 },
    });
    const serialized = JSON.stringify(digest);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(DIGEST_DEFAULT_BUDGET_BYTES);
  });

  it("budget override respected (tiny budget forces trimming, still valid digest@1)", () => {
    const sessions = Array.from({ length: 10 }, (_, i) =>
      syntheticSession(`s${i}`, `2026-09-01T10:0${i}:00Z`, "filler ".repeat(200)),
    );
    const digest = buildDigest(
      { sessions, coverage: { eligible: 10, analyzed: 10, omitted: 0 } },
      { budgetBytes: 2048 },
    );
    expect(Buffer.byteLength(JSON.stringify(digest), "utf8")).toBeLessThanOrEqual(2048);
    expect(digest.schema).toBe("digest@1");
  });

  it("sampling: >50 eligible sessions selects the 50 most recent sessions regardless of input order", () => {
    const sessions = Array.from({ length: 120 }, (_, i) =>
      // Sessions spread hourly across 5 days; ids encode their time order.
      syntheticSession(
        `s${String(i).padStart(3, "0")}`,
        new Date(Date.parse("2026-10-02T00:00:00Z") + i * 3600_000).toISOString(),
        `session number ${i}`,
      ),
    );
    const digest = buildDigest({
      sessions: [...sessions].reverse(),
      coverage: { eligible: 120, analyzed: 120, omitted: 0 },
    });
    const selected = digest.eventSequences.map((s) => s.sessionId);
    expect(selected).toHaveLength(DIGEST_MAX_SESSIONS);
    expect(selected).toEqual(
      Array.from({ length: DIGEST_MAX_SESSIONS }, (_, i) =>
        `s${String(i + 70).padStart(3, "0")}`,
      ),
    );
    // Same sessions in a different order yield the same selection.
    const again = buildDigest({ sessions, coverage: { eligible: 120, analyzed: 120, omitted: 0 } });
    expect(again.eventSequences.map((s) => s.sessionId)).toEqual(selected);
  });

  it("sampling: valid timestamps outrank invalid timestamps and session IDs break ties", () => {
    const recent = Array.from({ length: 49 }, (_, i) =>
      syntheticSession(
        `recent-${String(i).padStart(2, "0")}`,
        new Date(Date.parse("2026-10-02T00:00:00Z") + i * 3600_000).toISOString(),
        `recent ${i}`,
      ),
    );
    const tied = [
      syntheticSession("tie-z", "2026-10-01T00:00:00Z", "tie z"),
      syntheticSession("tie-a", "2026-10-01T00:00:00Z", "tie a"),
    ];
    const invalid = [
      syntheticSession("invalid-b", "not-a-date", "invalid b"),
      syntheticSession("invalid-a", "also-not-a-date", "invalid a"),
    ];

    const digest = buildDigest({
      sessions: [...invalid, ...recent, ...tied],
      coverage: { eligible: 53, analyzed: 53, omitted: 0 },
    });

    const selected = digest.eventSequences.map((sequence) => sequence.sessionId);
    expect(selected).toHaveLength(DIGEST_MAX_SESSIONS);
    expect(selected).toContain("tie-a");
    expect(selected).not.toContain("tie-z");
    expect(selected).not.toContain("invalid-a");
    expect(selected).not.toContain("invalid-b");
  });

  it("sampling: sets of 50 or fewer retain every session, including invalid timestamps", () => {
    const sessions = [
      syntheticSession("valid-new", "2026-09-02T00:00:00Z", "new"),
      syntheticSession("invalid", "not-a-date", "unknown"),
      syntheticSession("valid-old", "2026-09-01T00:00:00Z", "old"),
    ];

    const digest = buildDigest({
      sessions: [...sessions].reverse(),
      coverage: { eligible: 3, analyzed: 3, omitted: 0 },
    });

    expect(digest.eventSequences.map((sequence) => sequence.sessionId)).toEqual([
      "invalid",
      "valid-new",
      "valid-old",
    ]);
    expect(digest.counters["samplingSelected"]).toBe(3);
    expect(digest.counters["samplingOmitted"]).toBe(0);
  });

  it("redact-before-finalize: secret-like content in snippets is redacted in the digest", () => {
    const session = syntheticSession(
      "s-secret",
      "2026-09-01T10:00:00Z",
      "please use bearer sk-abcdefABCDEF1234567890abcdef1234 for the API",
    );
    const digest = buildDigest({
      sessions: [session],
      coverage: { eligible: 1, analyzed: 1, omitted: 0 },
    });
    const serialized = JSON.stringify(digest);
    expect(serialized.includes("sk-abcdefABCDEF1234567890abcdef1234")).toBe(false);
    // The redaction pass is the shared one.
    expect(redact("bearer sk-abcdefABCDEF1234567890abcdef1234 for the API")).not.toContain(
      "sk-abcdefABCDEF1234567890abcdef1234",
    );
  });

  it("deterministic: same input yields equivalent digest (only timestamps normalized)", () => {
    const sessions = [
      syntheticSession("s1", "2026-09-01T10:00:00Z", "first"),
      syntheticSession("s2", "2026-09-02T10:00:00Z", "second"),
    ];
    const a = buildDigest({ sessions, coverage: { eligible: 2, analyzed: 2, omitted: 0 } });
    const b = buildDigest({ sessions, coverage: { eligible: 2, analyzed: 2, omitted: 0 } });
    expect(b).toEqual(a);
  });
});

describe("renderPreview (4.3/4.4)", () => {
  it("preview is identical to the payload that would be sent", () => {
    const sessions = [
      syntheticSession("s1", "2026-09-01T10:00:00Z", "first"),
      syntheticSession(
        "s2",
        "2026-09-02T10:00:00Z",
        "second bearer sk-abcdefABCDEF1234567890abcdef1234",
      ),
    ];
    const digest = buildDigest({ sessions, coverage: { eligible: 2, analyzed: 2, omitted: 0 } });
    const preview = renderPreview(digest);
    // Canonical serialization: parsing the preview yields the same object.
    expect(JSON.parse(preview)).toEqual(digest);
    // Deterministic byte-for-byte across calls (stable key order).
    expect(renderPreview(digest)).toBe(preview);
  });
});
