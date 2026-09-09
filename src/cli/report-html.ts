/**
 * add-html-report — standalone HTML report renderer.
 *
 * Mirrors the Markdown renderers in src/cli/report.ts 1:1 (header, coverage,
 * dimensions, total score only when numeric, diagnosis, recommendations,
 * confidence, CTA) as a self-contained HTML document:
 *
 * - ALL untrusted interpolated text is entity-escaped (escapeHtml).
 * - No scripts, no external assets, no network references — inline CSS only.
 * - One orchestrated load moment (main entrance + the score rails filling
 *   together), disabled by `prefers-reduced-motion: reduce` (content stays
 *   fully visible), plus print styles.
 * - Semantic accessible markup: lang, landmarks, heading hierarchy,
 *   aria-labelledby sections, `<time datetime>`, a native `<details>` disclosure
 *   (keyboard-accessible) whose content is forced visible in print.
 * - Information hierarchy: a prominent overall-score overview + five aligned
 *   comparison lanes, then ONE consolidated prioritized action area (the
 *   model's concrete guidance, strongest first). The compact local-metrics and
 *   coverage snapshot is a visible sidebar panel; only the secondary
 *   provenance (layer attribution) is collapsed into the disclosure.
 * - The dimension note and its evidence appear ONCE, in the prioritized action
 *   area, with clear priority weight; the lanes are a clean comparison (name |
 *   rail | score).
 * - Numeric safety: a score is only ever shown when it is a finite 0–100
 *   number; otherwise the dimension reports "not evaluable". The hero total is
 *   only shown when total is a valid number AND every dimension is evaluable.
 * - The incomplete report NEVER renders any score (never fabricated).
 *
 * Visual direction (frontend-design skill): the subject is session-flow
 * metrics, so the report reads like a calibrated measurement of a flow — a sober,
 * grounded palette of measured slate-ink on cool field paper, a teal-verdigris
 * "signal" for the score rails, and a bookish serif for the measured values
 * against a humanist sans for the prose. No templated near-black + acid or
 * cream + terracotta treatment, no boxed SaaS card kit, no all-caps eyebrow
 * labels, no middle-dot meta strings, no appended decorative arrows.
 */
import type { CompleteReportInput, IncompleteReportInput } from "./report.js";

/** Entity-escape `& < > " '` (order-safe: `&` first, then the rest). */
export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

const STYLE = `
:root {
  color-scheme: light;
  --paper: #f4f6f5;
  --ink: #22333b;
  --muted: #5d707a;
  --rule: #c9d5d2;
  --signal: #2a7a6f;
  --signal-deep: #1d5a52;
  --signal-tint: #dfeae7;
  --inset: #eef1f0;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  font-family: "Avenir Next", Avenir, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  line-height: 1.6;
  color: var(--ink);
  background: var(--paper);
  overflow-wrap: anywhere;
}
header { max-width: 72rem; margin: 0 auto; padding: 2rem 1.5rem 0.5rem; }
main {
  max-width: 72rem;
  margin: 0 auto;
  padding: 0 1.5rem 3rem;
}
h1 {
  font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  font-size: 1.9rem;
  line-height: 1.15;
  margin: 0 0 0.4rem;
}
h2 {
  font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  font-size: 1.25rem;
  line-height: 1.2;
  margin: 0 0 0.5rem;
}
h3 {
  font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  font-size: 1rem;
  line-height: 1.2;
  margin: 0;
}
p { margin: 0.3rem 0; }
.muted { color: var(--muted); }
.notice { font-weight: 600; }
.evidence { color: var(--muted); font-size: 0.85rem; overflow-wrap: anywhere; }
code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  overflow-wrap: anywhere;
  background: var(--inset);
  padding: 0.08em 0.35em;
  border-radius: 0.25em;
}
a, a:visited { color: var(--signal-deep); text-decoration: underline; }
a:focus-visible, button:focus-visible { outline: 3px solid var(--signal); outline-offset: 2px; }

main { animation: ryf-enter 0.4s ease-out both; }
section {
  margin: 1.5rem 0 0;
  padding-top: 1.25rem;
  border-top: 1px solid var(--rule);
}

/* Two-column desktop layout; single column under 60rem. */
.report-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 20rem);
  gap: 2.5rem;
  align-items: start;
  margin-top: 1rem;
}
.report-primary > section:first-of-type { border-top: 0; padding-top: 0; margin-top: 0; }
@media (max-width: 60rem) {
  .report-layout { grid-template-columns: 1fr; gap: 2rem; }
}

/* Prominent overall-score overview. */
.hero { text-align: left; }
.hero-total {
  font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  font-size: 3rem;
  line-height: 1;
  margin: 0.25rem 0 0.4rem;
}
.flow-track {
  position: relative;
  display: block;
  height: 0.75rem;
  margin: 0.4rem 0 0.25rem;
  border-radius: 999px;
  background: var(--signal-tint);
  overflow: hidden;
}
.flow-track-fill {
  position: absolute;
  top: 0; bottom: 0; left: 0;
  background: var(--signal);
  border-radius: 999px;
  transform-origin: left center;
  animation: ryf-fill 0.9s ease-out both;
}

/* Aligned comparison lanes: name | rail | score (clean, no note). */
.cards { display: block; }
.cards > * { min-width: 0; }
.card { min-width: 0; margin-bottom: 0.6rem; }
.card .lane {
  display: grid;
  grid-template-columns: minmax(0, 9.5rem) minmax(0, 1fr) auto;
  gap: 0.9rem;
  align-items: center;
}
.card .lane-name { color: var(--signal-deep); }
.card .rail {
  display: block;
  height: 0.55rem;
  border-radius: 999px;
  background: var(--signal-tint);
  overflow: hidden;
}
.card .fill {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--signal);
  transform-origin: left center;
  animation: ryf-fill 0.9s ease-out both;
}
.card .lane-score {
  font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  font-weight: 700;
  font-size: 1.05rem;
  white-space: nowrap;
  text-align: right;
}
.card .lane-unevaluable { color: var(--muted); font-weight: 400; }

/* Consolidated prioritized actions (the model's guidance, strongest first). */
.priority ol { margin: 0.25rem 0 0; padding-left: 1.4rem; }
.priority li { margin: 0.4rem 0; }

/* Sidebar: visible compact metrics snapshot + collapsed provenance disclosure. */
.report-aside { min-width: 0; }
.report-aside > section:first-of-type { border-top: 0; padding-top: 0; margin-top: 0; }
.snapshot { font-size: 0.95rem; }
.snapshot h2 { font-size: 1.05rem; }
.snapshot p { margin: 0.35rem 0; }
.snapshot strong { color: var(--signal-deep); }
.report-details {
  border-top: 1px solid var(--rule);
  margin-top: 1.5rem;
  padding-top: 1rem;
}
.report-details > summary {
  cursor: pointer;
  font-family: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
  font-size: 1.05rem;
  font-weight: 600;
}
.report-details[open] > summary { margin-bottom: 0.5rem; }
.report-details section { border-top: 0; padding-top: 0.5rem; margin-top: 0.75rem; }

@keyframes ryf-enter {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: none; }
}
@keyframes ryf-fill {
  from { transform: scaleX(0); }
  to { transform: scaleX(1); }
}
@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
  main, section { opacity: 1; transform: none; visibility: visible; }
  /* Score rails keep their final width when ryf-fill is disabled. */
  .card .fill { animation: none; }
}
@media print {
  body { color: #000; background: #fff; }
  * { animation: none !important; transition: none !important; }
  section { box-shadow: none; break-inside: avoid; animation: none; }
  main { animation: none; }
      .report-layout { grid-template-columns: 1fr; }
      /* Collapsed disclosure content still prints: force the contents visible. */
      details { display: block !important; }
      details > :not(summary) { display: block !important; visibility: visible !important; }
      /* Chromium applies a default ::details-content { content-visibility: hidden }
         that keeps closed disclosure content from printing; force it visible so the
         provenance disclosure content prints even when collapsed. */
      details::details-content { content-visibility: visible !important; }
    }
    @media (max-width: 480px) {
  header, main { padding-left: 0.75rem; padding-right: 0.75rem; }
  h1 { font-size: 1.5rem; }
  .hero-total { font-size: 2.4rem; }
  .card .lane { grid-template-columns: 1fr; gap: 0.35rem; }
  .card .lane-score { text-align: left; }
}
`.trim();

function documentShell(title: string, body: string): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    body,
    "</body>",
    "</html>",
  ].join("\n");
}

function headerBlock(timestamp: string, durationLine: string): string {
  return [
    "<header>",
    '<h1 id="report-title">Rate Your Flow analysis report</h1>',
    `<p class="muted">Generated: <time datetime="${escapeHtml(timestamp)}">${escapeHtml(timestamp)}</time></p>`,
    `<p class="muted">${escapeHtml(durationLine)}</p>`,
    "</header>",
  ].join("\n");
}

function premiumCtaSection(): string {
  return [
    '<section aria-labelledby="premium-heading">',
    '<h2 id="premium-heading">Premium (informational)</h2>',
    "<p>A future premium tier is planned: deeper skills generation and install.</p>",
    "<p>If you are interested, contact:</p>",
    "<ul>",
    "<li>X: @ram4_dev</li>",
    "<li>Email: ramirocarnicersouble8@gmail.com</li>",
    "</ul>",
    '<p class="muted">Informational notice only. Nothing was sent or opened automatically.</p>',
    "</section>",
  ].join("\n");
}

function attributionSection(text: string): string {
  return [
    '<section aria-labelledby="attribution-heading">',
    '<h2 id="attribution-heading">Layer attribution</h2>',
    `<p>${escapeHtml(text)}</p>`,
    "</section>",
  ].join("\n");
}

function evidenceSuffix(evidence: { sessionId: string; line: number }[]): string {
  if (evidence.length === 0) {
    return "";
  }
  return ` <span class="evidence">(evidence: ${escapeHtml(
    evidence.map((ref) => `${ref.sessionId}:${ref.line}`).join(", "),
  )})</span>`;
}

/** A score is renderable only when it is a finite number within 0–100. */
function isValidScore(score: number | undefined): score is number {
  return typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 100;
}

/** A dimension is displayed with a score only when evaluable AND the score is valid. */
function isEvaluable(dimension: CompleteReportInput["response"]["dimensions"][number]): boolean {
  return dimension.evaluable === true && isValidScore(dimension.score);
}

function localMetricsSnapshotLine(metrics: CompleteReportInput["metrics"]): string {
  if (metrics.sessions.length === 0) {
    return "Tool calls: not available. Episodes: not available.";
  }
  const toolCalls = metrics.sessions.reduce<{ total: number; resolved: number; errored: number }>(
    (sum, s) => ({
      total: sum.total + s.toolCalls.total,
      resolved: sum.resolved + s.toolCalls.resolved,
      errored: sum.errored + s.toolCalls.errored,
    }),
    { total: 0, resolved: 0, errored: 0 },
  );
  const episodes = metrics.sessions.reduce((sum, s) => sum + s.episodeCount, 0);
  return `${toolCalls.total} tool calls (${toolCalls.resolved} resolved, ${toolCalls.errored} errored), ${episodes} episodes.`;
}

function localCoverageSnapshotLine(metrics: CompleteReportInput["metrics"]): string {
  const { eligible, analyzed, omitted } = metrics.coverage;
  return `${analyzed}/${eligible} sessions parsed (${omitted} omitted).`;
}

/** Visible, compact metrics/converage snapshot for the sidebar. */
function snapshotSection(
  metrics: CompleteReportInput["metrics"],
  digestCoverage?: { samplingSelected: number; samplingOmitted: number },
): string {
  const parts: string[] = [
    '<section class="snapshot" aria-labelledby="snapshot-heading">',
    '<h2 id="snapshot-heading">At a glance</h2>',
    `<p><strong>Coverage:</strong> ${escapeHtml(localCoverageSnapshotLine(metrics))}</p>`,
  ];
  if (digestCoverage !== undefined) {
    parts.push(
      `<p><strong>Semantic sample coverage:</strong> ${escapeHtml(`The latest ${digestCoverage.samplingSelected} sessions were selected for semantic analysis; ${digestCoverage.samplingOmitted} set aside.`)}</p>`,
    );
  }
  parts.push(
    `<p><strong>Local metrics:</strong> ${escapeHtml(localMetricsSnapshotLine(metrics))}</p>`,
  );
  parts.push("</section>");
  return parts.join("\n");
}

/** Aligned comparison lanes, one per dimension, rendered in the primary column. */
function dashboardSection(response: CompleteReportInput["response"]): string {
  const parts: string[] = [];
  parts.push('<section class="cards" aria-labelledby="scores-heading">');
  parts.push('<h2 id="scores-heading">Dimensions</h2>');
  for (const dimension of response.dimensions) {
    const headingId = `dim-${escapeHtml(dimension.dimension)}`;
    if (isEvaluable(dimension)) {
      parts.push(
        [
          `<article class="card" aria-labelledby="${headingId}">`,
          `<div class="lane">`,
          `<h3 id="${headingId}" class="lane-name">${escapeHtml(dimension.dimension)}</h3>`,
          `<span class="rail" aria-hidden="true"><span class="fill" style="width:${escapeHtml(String(dimension.score))}%"></span></span>`,
          `<span class="lane-score">${escapeHtml(String(dimension.score))}/100</span>`,
          `</div>`,
          "</article>",
        ].join("\n"),
      );
    } else {
      parts.push(
        [
          `<article class="card" aria-labelledby="${headingId}">`,
          `<div class="lane">`,
          `<h3 id="${headingId}" class="lane-name">${escapeHtml(dimension.dimension)}</h3>`,
          `<span class="lane-score lane-unevaluable">not evaluable</span>`,
          `</div>`,
          "</article>",
        ].join("\n"),
      );
    }
  }
  parts.push("</section>");
  return parts.join("\n");
}

/** Hero total rendered as a measured flow-track rail only when the total is a valid number. */
function heroSection(total: number): string {
  return [
    '<section class="hero" aria-labelledby="hero-heading">',
    '<h2 id="hero-heading">Overall score</h2>',
    `<p class="hero-total"><strong>${escapeHtml(String(total))}</strong> /100</p>`,
    `<span class="flow-track" aria-hidden="true"><span class="flow-track-fill" style="width:${escapeHtml(String(total))}%"></span></span>`,
    '<p class="muted">Weighted across all five dimensions, each with a model assessment.</p>',
    "</section>",
  ].join("\n");
}

/**
 * ONE consolidated prioritized action area: the model's concrete guidance for
 * every evaluable dimension, weakest score first (strongest need first). The
 * dimension notes live here (once); the lanes above are a clean comparison.
 */
function prioritySection(response: CompleteReportInput["response"]): string {
  const scored = response.dimensions
    .filter(isEvaluable)
    .sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
  const parts: string[] = [
    '<section class="priority" aria-labelledby="priority-heading">',
    '<h2 id="priority-heading">Priority</h2>',
  ];
  if (scored.length === 0) {
    parts.push('<p class="muted">No dimension was scored, so there is nothing to prioritize.</p>');
  } else {
    parts.push("<ol>");
    for (const dimension of scored) {
      parts.push(
        `<li><strong>${escapeHtml(dimension.dimension)}</strong>: ${escapeHtml(dimension.notes)}${evidenceSuffix(dimension.evidence)}</li>`,
      );
    }
    parts.push("</ol>");
  }
  parts.push("</section>");
  return parts.join("\n");
}

function confidenceSection(note: string): string {
  return [
    '<section aria-labelledby="confidence-heading">',
    '<h2 id="confidence-heading">Confidence</h2>',
    `<p>${escapeHtml(note)}</p>`,
    "</section>",
  ].join("\n");
}

/** Render the complete report as a standalone HTML document (deterministic given inputs). */
export function renderCompleteHtml(input: CompleteReportInput): string {
  const { response, metrics, durationMs, timestamp } = input;
  const parts: string[] = [];

  parts.push(headerBlock(timestamp, `Duration: ${durationMs} ms (measured total)`));
  parts.push("<main>");

  const primary: string[] = [];
  // Dashboard: hero total + aligned lanes, BEFORE the metadata. Hero requires a
  // valid total AND every dimension truly evaluable — otherwise suppress it and
  // render honest "not evaluable" lanes.
  const allDimsScored = response.dimensions.every(isEvaluable);
  if (isValidScore(response.total) && allDimsScored) {
    primary.push(heroSection(response.total));
  }
  primary.push(dashboardSection(response));
  primary.push(prioritySection(response));

  const aside: string[] = [];
  aside.push(snapshotSection(metrics, input.digestCoverage));
  aside.push(
    reportDetailsDisclosure(
      attributionSection(
        "Scores are the model's semantic assessment of digest evidence against rubric v1. " +
          "Local metrics are supporting evidence only; they never replaced or capped a dimension.",
      ),
    ),
  );

  parts.push('<div class="report-layout">');
  parts.push('<div class="report-primary">');
  parts.push(...primary);
  parts.push("</div>");
  parts.push(`<aside class="report-aside" aria-label="Report details">${aside.join("\n")}</aside>`);
  parts.push("</div>");

  parts.push(confidenceSection(response.confidenceNote));
  parts.push(premiumCtaSection());
  parts.push("</main>");
  return documentShell("Rate Your Flow analysis report", parts.join("\n"));
}

/** Render the incomplete report as a standalone HTML document — never a fabricated score. */
export function renderIncompleteHtml(input: IncompleteReportInput): string {
  const { errorCode, retryAfterSeconds, metrics, durationMs, timestamp } = input;
  const parts: string[] = [];
  parts.push(headerBlock(timestamp, `Duration: ${durationMs} ms`));
  parts.push("<main>");

  parts.push('<div class="report-layout">');
  parts.push('<div class="report-primary">');
  parts.push('<section aria-labelledby="incomplete-heading">');
  parts.push('<h2 id="incomplete-heading">Analysis incomplete</h2>');
  // Dominant copy is plain and actionable; the invariant note lives in the
  // attribution block below (never shouted here), and the error code is a
  // compact secondary "Technical details" line.
  parts.push(
    `<p class="notice">analysis incomplete. ${escapeHtml(incompleteGuidance(errorCode))}</p>`,
  );
  parts.push(`<p>Technical details: <code>${escapeHtml(errorCode)}</code></p>`);
  if (retryAfterSeconds !== undefined) {
    parts.push(`<p>Retry-after: ${escapeHtml(String(retryAfterSeconds))} seconds</p>`);
  }
  parts.push("</section>");
  parts.push("</div>");

  const aside: string[] = [];
  aside.push(snapshotSection(metrics));
  aside.push(
    reportDetailsDisclosure(
      attributionSection(
        "This report has local metrics only; the semantic layer did not complete, so no dimension scores exist here.",
      ),
    ),
  );
  parts.push(`<aside class="report-aside" aria-label="Report details">${aside.join("\n")}</aside>`);
  parts.push("</div>");

  parts.push(premiumCtaSection());
  parts.push("</main>");
  return documentShell("Rate Your Flow analysis report (incomplete)", parts.join("\n"));
}

/** Wrap the secondary provenance in a keyboard-accessible, print-visible disclosure. */
function reportDetailsDisclosure(section: string): string {
  return [
    '<details class="report-details">',
    "<summary>Provenance</summary>",
    section,
    "</details>",
  ].join("\n");
}

/** Plain, actionable guidance for the incomplete report's known-error cases. */
function incompleteGuidance(errorCode: string): string {
  switch (errorCode) {
    case "endpoint_not_configured":
    case "missing_configuration":
      return (
        "No analysis endpoint is set. Set RYF_ENDPOINT, or run ryf --endpoint <url> " +
        "once to consent, then rerun."
      );
    case "endpoint_unreachable":
      return (
        "The endpoint you configured did not answer. Check that the URL is reachable, " +
        "the PORT is correct, and the provider service is running, then rerun."
      );
    default:
      return "The semantic analysis could not be completed. Review the technical details below, then rerun.";
  }
}
