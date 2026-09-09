/**
 * U3 digest review remediations (root r3): (1) content arrays + pi top-level
 * shape + tool-output extraction; (2) redact BEFORE clip (secret straddling
 * the 160-char boundary); (3) hard budget via bounded episode/event sampling
 * while retaining snippets; coverage recomputed after max-50 sampling;
 * explicit typed error when the minimal envelope cannot fit.
 */
import { describe, expect, it } from "vitest";
import { buildDigest } from "../../src/cli/digest.js";
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
  ];
  return {
    source: "codex",
    sourceVersion: "codex@1",
    sessionId: id,
    filePath: `/tmp/${id}.jsonl`,
    records,
    episodes: [{ branchId: "main", events: records.slice(1), lineRefs: [2] }],
    toolCalls: [],
    tokenEvents: [],
    warnings: [],
    latestRecordTimestamp: ts,
  };
}

describe("U3 review remediations (root r3)", () => {
  it("(1a) codex content ARRAYS extracted into snippets; tool outputs surfaced", () => {
    const session: Session = {
      source: "codex",
      sourceVersion: "codex@1",
      sessionId: "s-array",
      filePath: "/tmp/s-array.jsonl",
      records: [
        {
          line: 1,
          type: "session_meta",
          timestamp: "2026-09-01T10:00:00Z",
          payload: { id: "s-array" },
        },
        {
          line: 2,
          type: "response_item",
          timestamp: "2026-09-01T10:00:05Z",
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "text", text: "please review the failing test" },
              { type: "text", text: "and propose a fix" },
            ],
          },
        },
        {
          line: 3,
          type: "response_item",
          timestamp: "2026-09-01T10:01:00Z",
          payload: {
            type: "function_call_output",
            call_id: "c9",
            output: "exit code 1: 2 tests failed",
          },
        },
      ],
      episodes: [{ branchId: "main", events: [], lineRefs: [2, 3] }],
      toolCalls: [],
      tokenEvents: [],
      warnings: [],
      latestRecordTimestamp: "2026-09-01T10:01:00Z",
    };
    const digest = buildDigest({
      sessions: [session],
      coverage: { eligible: 1, analyzed: 1, omitted: 0 },
    });
    const texts = digest.citedSnippets.map((s) => s.text);
    expect(texts.some((x) => x.includes("please review the failing test"))).toBe(true);
    expect(texts.some((x) => x.includes("and propose a fix"))).toBe(true);
    // Tool outputs surfaced (bounded, redacted).
    expect(texts.some((x) => x.includes("2 tests failed"))).toBe(true);
  });

  it("(1b) pi message records (top-level payload shape) extract prompt/response text", () => {
    const session: Session = {
      source: "pi",
      sourceVersion: "pi@1",
      sessionId: "pi-arr",
      filePath: "/tmp/pi-arr.jsonl",
      records: [
        {
          line: 1,
          type: "message",
          timestamp: "2026-09-02T10:00:05Z",
          payload: {
            type: "message",
            id: "m1",
            role: "user",
            content: "explore the repository now",
          },
        },
        {
          line: 2,
          type: "message",
          timestamp: "2026-09-02T10:00:30Z",
          payload: { type: "message", id: "m2", role: "assistant", content: "found 2 files" },
        },
      ],
      episodes: [{ branchId: "m2", events: [], lineRefs: [1, 2] }],
      toolCalls: [],
      tokenEvents: [],
      warnings: [],
      latestRecordTimestamp: "2026-09-02T10:00:30Z",
    };
    const digest = buildDigest({
      sessions: [session],
      coverage: { eligible: 1, analyzed: 1, omitted: 0 },
    });
    const texts = digest.citedSnippets.map((s) => s.text);
    expect(texts.some((x) => x.includes("explore the repository now"))).toBe(true);
    expect(texts.some((x) => x.includes("found 2 files"))).toBe(true);
  });

  it("(2) redact BEFORE clip: secret straddling the 160-char boundary never leaks a prefix", () => {
    // 156 padding chars + "bearer " + 40-char token: the clip at 160 leaves
    // only 4 token chars — clip-before-redact leaks them (pattern cannot match
    // a 4-char token); redact-first erases the full token BEFORE clipping.
    const padding = "a".repeat(156);
    const session = syntheticSession(
      "s-straddle",
      "2026-09-01T10:00:00Z",
      `${padding}bearer ${"T".repeat(40)} end`,
    );
    const digest = buildDigest({
      sessions: [session],
      coverage: { eligible: 1, analyzed: 1, omitted: 0 },
    });
    for (const snippet of digest.citedSnippets) {
      // No raw-token fragment of any length survives in any snippet.
      expect(snippet.text.includes("TTTT")).toBe(false);
      expect(snippet.text.includes("TT")).toBe(false);
    }
  });

  it("(3) budget: bounded episode sampling retains snippets; coverage recomputed after sampling", () => {
    const sessions = Array.from({ length: 30 }, (_, i) => {
      const s = syntheticSession(
        `e${i}`,
        `2026-09-01T${String(i % 24).padStart(2, "0")}:00:00Z`,
        `valuable evidence for session ${i}`,
      );
      s.episodes = Array.from({ length: 5 }, (_, j) => ({
        branchId: `b${j}`,
        events: s.records.slice(1),
        lineRefs: [2],
      }));
      return s;
    });
    const digest = buildDigest(
      { sessions, coverage: { eligible: 30, analyzed: 30, omitted: 0 } },
      { budgetBytes: 4096 },
    );
    expect(Buffer.byteLength(JSON.stringify(digest), "utf8")).toBeLessThanOrEqual(4096);
    // Semantic snippets retained (not trimmed to zero before metadata).
    expect(digest.citedSnippets.length).toBeGreaterThan(0);
    // Coverage recomputed AFTER max-50 sampling.
    expect(digest.counters["samplingSelected"]).toBe(30);
    expect(digest.counters["samplingOmitted"]).toBe(0);
    const many = Array.from({ length: 80 }, (_, i) =>
      syntheticSession(`m${i}`, `2026-09-0${(i % 7) + 1}T10:00:00Z`, `evidence ${i}`),
    );
    const digest2 = buildDigest({
      sessions: many,
      coverage: { eligible: 80, analyzed: 80, omitted: 0 },
    });
    expect(digest2.counters["samplingSelected"]).toBe(50);
    expect(digest2.counters["samplingOmitted"]).toBe(30);
  });

  it("(3) impossible minimal envelope: explicit typed error, never silent over-budget", () => {
    const sessions = Array.from({ length: 60 }, (_, i) =>
      syntheticSession(`z${i}`, `2026-09-0${(i % 7) + 1}T10:00:00Z`, "e"),
    );
    expect(() =>
      buildDigest(
        { sessions, coverage: { eligible: 60, analyzed: 60, omitted: 0 } },
        { budgetBytes: 200 },
      ),
    ).toThrowError(/cannot fit/i);
  });
});
