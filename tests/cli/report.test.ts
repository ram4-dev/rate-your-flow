/**
 * 8.1/8.3 RED: local report + informational CTA. Complete and incomplete
 * report shapes, layer attribution, time/coverage, no fabricated score on
 * failure, exact premium contacts, never auto-open/send.
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderCompleteReport, renderIncompleteReport, saveReport } from "../../src/cli/report.js";
import type { AnalyzeResponse } from "../../src/shared/contracts/analysis@1.js";
import type { LocalMetrics } from "../../src/cli/metrics.js";

const METRICS: LocalMetrics = {
  supportingEvidenceNote: "supporting evidence only",
  coverage: { eligible: 6, analyzed: 3, omitted: 3 },
  sessions: [],
};

const COMPLETE: AnalyzeResponse = {
  schema: "analysis@1",
  outcome: "complete",
  dimensions: [
    {
      dimension: "reliability",
      score: 72,
      evaluable: true,
      evidence: [{ sessionId: "s1", line: 2 }],
      notes: "mostly verified completions",
    },
    {
      dimension: "communication",
      score: 65,
      evaluable: true,
      evidence: [{ sessionId: "s1", line: 2 }],
      notes: "some vague prompts",
    },
    {
      dimension: "context-efficiency",
      score: 80,
      evaluable: true,
      evidence: [],
      notes: "compact context",
    },
    {
      dimension: "productivity",
      score: 55,
      evaluable: true,
      evidence: [],
      notes: "some stalls",
    },
    {
      dimension: "hygiene",
      score: 90,
      evaluable: true,
      evidence: [],
      notes: "clean operations",
    },
  ],
  total: 72.4,
  confidenceNote: "descriptive reading of evidence, not a calibrated probability",
};

describe("renderCompleteReport (8.1)", () => {
  it("per-dimension notes, diagnosis, cited recommendations, time/coverage, layer attribution", () => {
    const markdown = renderCompleteReport({
      response: COMPLETE,
      metrics: METRICS,
      durationMs: 1234,
      timestamp: "2026-09-07T12:00:00Z",
    });
    for (const dimension of COMPLETE.dimensions) {
      expect(markdown).toContain(dimension.dimension);
      expect(markdown).toContain(String(dimension.score));
      expect(markdown).toContain(dimension.notes);
    }
    expect(markdown).toContain("72.4"); // principal total
    expect(markdown).toContain("1234"); // duration
    expect(markdown).toContain("3/6"); // coverage analyzed/eligible surfaced
    // Layer attribution: which layer contributed what (case-insensitive).
    const lowered = markdown.toLowerCase();
    expect(lowered).toContain("semantic");
    expect(lowered).toContain("local metrics");
  });

  it("evidence citations rendered as resolvable references", () => {
    const markdown = renderCompleteReport({
      response: COMPLETE,
      metrics: METRICS,
      durationMs: 1000,
      timestamp: "2026-09-07T12:00:00Z",
    });
    expect(markdown).toContain("s1:2");
  });
});

describe("renderIncompleteReport (8.1)", () => {
  it("no principal score; explicit incomplete notice; local metrics surfaced; retry-after when present", () => {
    const markdown = renderIncompleteReport({
      errorCode: "over_quota",
      retryAfterSeconds: 30,
      metrics: METRICS,
      durationMs: 500,
      timestamp: "2026-09-07T12:00:00Z",
    });
    expect(markdown).toContain("analysis incomplete");
    expect(markdown).not.toMatch(/total score:?\s*\d/i);
    expect(markdown).toContain("over_quota");
    expect(markdown).toContain("30");
    expect(markdown.toLowerCase()).toContain("local metrics");
    expect(markdown).toContain("3/6");
  });
});

describe("premium CTA (8.3)", () => {
  it("exact contacts rendered; purely informational (no auto-open/send in the module)", () => {
    const complete = renderCompleteReport({
      response: COMPLETE,
      metrics: METRICS,
      durationMs: 1000,
      timestamp: "2026-09-07T12:00:00Z",
    });
    const incomplete = renderIncompleteReport({
      errorCode: "timeout",
      metrics: METRICS,
      durationMs: 1000,
      timestamp: "2026-09-07T12:00:00Z",
    });
    for (const markdown of [complete, incomplete]) {
      expect(markdown).toContain("@ram4_dev");
      expect(markdown).toContain("ramirocarnicersouble8@gmail.com");
      // The CTA states it is informational.
      expect(markdown.toLowerCase()).toContain("premium");
    }
  });
});

describe("root report review remediations", () => {
  it("recommendations render ACTUAL actionable notes with citations (no 'see notes above')", () => {
    const markdown = renderCompleteReport({
      response: COMPLETE,
      metrics: METRICS,
      durationMs: 1000,
      timestamp: "2026-09-07T12:00:00Z",
    });
    const recs = markdown.slice(markdown.indexOf("## Recommendations"));
    expect(recs).toContain("mostly verified completions"); // actual note text
    expect(recs).toContain("s1:2"); // citations carried into recommendations
    expect(recs).not.toContain("see notes above");
  });

  it("no per-phase timing claim unless real phase values are provided", () => {
    const markdown = renderCompleteReport({
      response: COMPLETE,
      metrics: METRICS,
      durationMs: 1234,
      timestamp: "2026-09-07T12:00:00Z",
    });
    // Only the measured total duration is shown; no invented per-phase values.
    expect(markdown).toContain("1234 ms");
    expect(markdown.toLowerCase()).not.toContain("per phase");
    expect(markdown.toLowerCase()).not.toContain("by phase");
  });

  it("digest sampling coverage distinguished from local coverage (>50 sampled)", () => {
    const markdown = renderCompleteReport({
      response: COMPLETE,
      metrics: METRICS,
      digestCoverage: { samplingSelected: 50, samplingOmitted: 70 },
      durationMs: 1000,
      timestamp: "2026-09-07T12:00:00Z",
    });
    expect(markdown).toContain("50"); // semantic sample
    expect(markdown).toContain("latest 50 sessions");
    expect(markdown).toContain("70"); // sampled-out
    expect(markdown.toLowerCase()).toContain("semantic sample");
    expect(markdown.toLowerCase()).toContain("local coverage");
  });
});

describe("saveReport (8.2)", () => {
  it("writes a timestamped local HTML file with mode 0o600", () => {
    const dir = mkdtempSync(join(tmpdir(), "ryf-reports-"));
    try {
      const path = saveReport(dir, "2026-09-07T12-00-00", '<html lang="en">…</html>');
      expect(path).toBe(join(dir, "2026-09-07T12-00-00.html"));
      const content = readFileSync(path, "utf8");
      expect(content).toContain("<html");
      const stats = statSync(path);
      // POSIX file mode: owner read/write only (local-only report).
      expect(stats.mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
