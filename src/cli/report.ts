/**
 * Local report writer (Phase 8, tasks 8.1–8.3; local-report spec).
 *
 * - Complete report: per-dimension notes + scores + evidence citations,
 *   diagnosis summary, cited recommendations, duration/coverage, layer
 *   attribution (semantic vs local metrics), principal total, premium CTA.
 * - Incomplete report: explicit "analysis incomplete" notice, error code +
 *   retry-after when present, local metrics surfaced, NO principal score.
 * - CTA: informational only — exact contacts (X @ram4_dev,
 *   ramirocarnicersouble8@gmail.com); the module NEVER opens, sends, or
 *   transmits anything (pure rendering + one file write).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AnalyzeResponse } from "../shared/contracts/analysis@1.js";
import type { LocalMetrics } from "./metrics.js";

const PREMIUM_CTA = [
  "## Premium (informational)",
  "",
  "A future premium tier is planned (deeper skills generation and install).",
  "If you are interested, contact:",
  "",
  "- X: @ram4_dev",
  "- Email: ramirocarnicersouble8@gmail.com",
  "",
  "This is an informational notice only — nothing was sent or opened automatically.",
].join("\n");

const PREMIUM_CTA_INCOMPLETE = [
  "## Premium (informational)",
  "",
  "A future premium tier is planned (deeper skills generation and install).",
  "If you are interested, contact:",
  "",
  "- X: @ram4_dev",
  "- Email: ramirocarnicersouble8@gmail.com",
  "",
  "This is an informational notice only — nothing was sent or opened automatically.",
].join("\n");

function coverageLine(metrics: LocalMetrics): string {
  const { eligible, analyzed, omitted } = metrics.coverage;
  return `Coverage: ${analyzed}/${eligible} sessions analyzed (${omitted} omitted) — supporting evidence only, not a total-coverage claim.`;
}

function evidenceLine(evidence: { sessionId: string; line: number }[]): string {
  if (evidence.length === 0) {
    return "";
  }
  return ` (evidence: ${evidence.map((ref) => `${ref.sessionId}:${ref.line}`).join(", ")})`;
}

export interface DigestCoverage {
  samplingSelected: number;
  samplingOmitted: number;
}

export interface CompleteReportInput {
  response: AnalyzeResponse;
  metrics: LocalMetrics;
  /** Digest sampling coverage (distinct from local window coverage). */
  digestCoverage?: DigestCoverage;
  durationMs: number;
  timestamp: string;
}

/** Render the complete markdown report (deterministic given inputs). */
export function renderCompleteReport(input: CompleteReportInput): string {
  const { response, metrics, durationMs, timestamp } = input;
  const lines: string[] = [
    "# Rate Your Flow — analysis report",
    "",
    `Generated: ${timestamp}`,
    `Duration: ${durationMs} ms (measured total)`,
    coverageLine(metrics),
    ...(input.digestCoverage === undefined
      ? []
      : [
          `Semantic sample coverage: the latest ${input.digestCoverage.samplingSelected} sessions were selected for model analysis (${input.digestCoverage.samplingOmitted} set aside) — distinct from local coverage above.`,
        ]),
    "",
    `Layer attribution: scores are SEMANTIC (model assessment of digest evidence against rubric v1); local metrics contributed supporting evidence only and never replaced or capped a dimension.`,
    "",
    "## Dimensions",
    "",
  ];
  for (const dimension of response.dimensions) {
    if (dimension.evaluable) {
      lines.push(
        `- ${dimension.dimension}: ${dimension.score}/100 — ${dimension.notes}${evidenceLine(dimension.evidence)}`,
      );
    } else {
      lines.push(`- ${dimension.dimension}: not evaluable — ${dimension.notes}`);
    }
  }
  lines.push("");
  if (typeof response.total === "number") {
    lines.push(`Total score: ${response.total} (weighted, all five dimensions evaluable)`);
    lines.push("");
  }
  lines.push("## Diagnosis");
  lines.push("");
  lines.push(
    response.dimensions
      .filter((d) => d.evaluable)
      .sort((a, b) => (a.score ?? 0) - (b.score ?? 0))
      .slice(0, 2)
      .map((d) => `Weakest areas: ${d.dimension} (${d.score}) — ${d.notes}`)
      .join("; "),
  );
  lines.push("");
  lines.push("## Recommendations");
  lines.push("");
  for (const dimension of response.dimensions) {
    if (dimension.evaluable && dimension.notes !== "") {
      lines.push(`- ${dimension.dimension}: ${dimension.notes}${evidenceLine(dimension.evidence)}`);
    }
  }
  lines.push("");
  lines.push(`Confidence: ${response.confidenceNote}`);
  lines.push("");
  lines.push(PREMIUM_CTA);
  return lines.join("\n");
}

export interface IncompleteReportInput {
  errorCode: string;
  retryAfterSeconds?: number;
  metrics: LocalMetrics;
  durationMs: number;
  timestamp: string;
}

/** Render the incomplete markdown report — never a fabricated score. */
export function renderIncompleteReport(input: IncompleteReportInput): string {
  const { errorCode, retryAfterSeconds, metrics, durationMs, timestamp } = input;
  const lines: string[] = [
    "# Rate Your Flow — analysis report",
    "",
    `Generated: ${timestamp}`,
    `Duration: ${durationMs} ms`,
    "",
    "**analysis incomplete** — the semantic analysis could not be completed, so NO total score is emitted (never fabricated).",
    "",
    `Reason: ${errorCode}`,
  ];
  if (retryAfterSeconds !== undefined) {
    lines.push(`Retry-after: ${retryAfterSeconds} seconds`);
  }
  lines.push("");
  lines.push("## Local metrics (supporting evidence only)");
  lines.push("");
  lines.push(coverageLine(metrics));
  lines.push(
    `Tool calls: ${metrics.sessions.reduce((sum, s) => sum + s.toolCalls.total, 0)} total, ${metrics.sessions.reduce((sum, s) => sum + s.toolCalls.resolved, 0)} resolved, ${metrics.sessions.reduce((sum, s) => sum + s.toolCalls.errored, 0)} errored.`,
  );
  lines.push(`Episodes: ${metrics.sessions.reduce((sum, s) => sum + s.episodeCount, 0)}.`);
  lines.push("");
  lines.push(
    "Layer attribution: this report contains LOCAL METRICS only; the semantic layer did not complete, so no dimension scores exist here.",
  );
  lines.push("");
  lines.push(PREMIUM_CTA_INCOMPLETE);
  return lines.join("\n");
}

/** Save a report under `<dir>/<timestamp>.html` (timestamped, local only). */
export function saveReport(dir: string, timestamp: string, html: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${timestamp}.html`);
  writeFileSync(path, `${html}\n`, { mode: 0o600 });
  return path;
}
