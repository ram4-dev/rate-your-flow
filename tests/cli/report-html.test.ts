/**
 * add-html-report — HTML renderer unit tests (strict TDD).
 *
 * Units:
 * - 1.1 renderCompleteHtml full-document structure + escapeHtml basics.
 * - 1.2 renderIncompleteHtml: incomplete notice, reason, retry-after, local
 *   metrics, layer attribution, CTA; zero score strings anywhere.
 * - 1.3 escaping + presentation guarantees (hostile text, reduced motion,
 *   print, no external references).
 * - Root QA: dashboard presentation (hero total, score cards with fill bars,
 *   above-the-fold scores), ACTUAL local metrics in the complete report,
 *   numeric safety (never NaN/Infinity/out-of-range), overflow-wrap CSS
 *   regression for long hostile strings at 390px.
 */
import { describe, expect, it } from "vitest";
import { escapeHtml, renderCompleteHtml, renderIncompleteHtml } from "../../src/cli/report-html.js";
import type { AnalyzeDimensions, AnalyzeResponse } from "../../src/shared/contracts/analysis@1.js";
import type { LocalMetrics } from "../../src/cli/metrics.js";

const METRICS: LocalMetrics = {
  supportingEvidenceNote: "supporting evidence only",
  coverage: { eligible: 6, analyzed: 3, omitted: 3 },
  sessions: [],
};

const METRICS_WITH_SESSIONS: LocalMetrics = {
  supportingEvidenceNote: "supporting evidence only",
  coverage: { eligible: 6, analyzed: 3, omitted: 3 },
  sessions: [
    {
      sessionId: "s1",
      source: "codex",
      sourceVersion: "1.0",
      toolCalls: { total: 12, resolved: 9, unresolved: 2, errored: 1 },
      episodeCount: 3,
      warnings: [],
    },
    {
      sessionId: "s2",
      source: "pi",
      sourceVersion: "2.0",
      toolCalls: { total: 4, resolved: 2, unresolved: 1, errored: 1 },
      episodeCount: 2,
      warnings: [],
    },
  ],
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

const PARTIAL: AnalyzeResponse = {
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
      evidence: [],
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
    { dimension: "hygiene", evaluable: false, evidence: [], notes: "insufficient evidence" },
  ],
  confidenceNote: "partial coverage",
};

function completeHtml(
  response: AnalyzeResponse,
  digestCoverage?: { samplingSelected: number; samplingOmitted: number },
  metrics: LocalMetrics = METRICS,
): string {
  return renderCompleteHtml({
    response,
    metrics,
    ...(digestCoverage === undefined ? {} : { digestCoverage }),
    durationMs: 1234,
    timestamp: "2026-09-07T12:00:00Z",
  });
}

describe("escapeHtml", () => {
  it("escapes &, <, >, \", ' in order-safe fashion", () => {
    expect(escapeHtml(`a & b < c > d "e" 'f'`)).toBe(
      "a &amp; b &lt; c &gt; d &quot;e&quot; &#39;f&#39;",
    );
  });

  it("does not double-escape pre-existing entities", () => {
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });
});

describe("renderCompleteHtml — full document structure (1.1)", () => {
  it("renders a complete standalone document with header, coverage, dimensions, total, diagnosis, recommendations, confidence, CTA", () => {
    const html = completeHtml(COMPLETE);
    // Standalone document, semantic accessible markup.
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain(`<html lang="en">`);
    expect(html).toContain("<header");
    expect(html).toContain("<main");
    expect(html).toContain("aria-labelledby");
    expect(html).toContain("<h1");
    expect(html).toContain("<h2");
    // Header facts.
    expect(html).toContain("Rate Your Flow");
    expect(html).toContain("2026-09-07T12:00:00Z");
    expect(html).toContain("1234");
    // Coverage surfaced (local).
    expect(html).toContain("3/6");
    // All five dimensions present with per-dimension scores.
    for (const dimension of COMPLETE.dimensions) {
      expect(html).toContain(dimension.dimension);
      expect(html).toContain(`${dimension.score}/100`);
      expect(html).toContain(dimension.notes);
    }
    // Evidence citations resolvable.
    expect(html).toContain("s1:2");
    // Total score (principal) rendered when numeric.
    expect(html).toContain("72.4");
    // Diagnosis: weakest 2 evaluable dimensions (productivity 55, communication 65).
    expect(html).toContain("productivity");
    expect(html).toContain("communication");
    // Confidence note.
    expect(html).toContain("descriptive reading of evidence, not a calibrated probability");
    // CTA contacts.
    expect(html).toContain("@ram4_dev");
    expect(html).toContain("ramirocarnicersouble8@gmail.com");
    // Layer attribution.
    expect(html.toLowerCase()).toContain("semantic");
    expect(html.toLowerCase()).toContain("local metrics");
  });

  it("renders digest sampling coverage when provided", () => {
    const html = completeHtml(COMPLETE, { samplingSelected: 50, samplingOmitted: 70 });
    expect(html).toContain("50");
    expect(html).toContain("70");
    expect(html.toLowerCase()).toContain("semantic sample");
  });

  it("renders per-dimension score only when evaluable; total score ONLY when response.total is numeric", () => {
    const html = completeHtml(PARTIAL);
    // Evaluable dimensions keep their scores.
    expect(html).toContain("72/100");
    // Not-evaluable dimension says so, never a fabricated score.
    expect(html).toContain("not evaluable");
    // A missing/absent total NEVER produces a total score line.
    expect(html).not.toContain("Total score");
    // The not-evaluable dimension has no /100 score string.
    const hygieneSection = html.slice(html.indexOf('id="dim-hygiene"'));
    expect(hygieneSection).not.toContain("/100");
  });

  it("dashboard presentation: hero total + five score cards with fill bars come BEFORE metadata sections", () => {
    const html = completeHtml(COMPLETE);
    // Five score cards.
    expect(html.match(/class="card"/g) ?? []).toHaveLength(5);
    // CSS score-fill bars proportional to the score (0-100).
    expect(html).toContain('style="width:72%"');
    expect(html).toContain('style="width:55%"');
    // Prominent hero total block.
    expect(html).toContain('class="hero"');
    expect(html).toContain("72.4");
    // Above the fold: total + dimension cards precede coverage/attribution.
    const totalPos = html.indexOf('class="hero"');
    const cardsPos = html.indexOf('class="cards"');
    expect(totalPos).toBeGreaterThan(-1);
    expect(cardsPos).toBeGreaterThan(-1);
    expect(totalPos).toBeLessThan(html.indexOf("Coverage"));
    expect(totalPos).toBeLessThan(html.indexOf("Layer attribution"));
    expect(cardsPos).toBeLessThan(html.indexOf("Coverage"));
    // Score-fill animation + responsive card grid.
    expect(html).toContain("@keyframes ryf-fill");
    expect(html).toContain("grid-template-columns");
    // Cards remain not-evaluable-aware (no fabricated bars).
    const partial = completeHtml(PARTIAL);
    const hygieneCard = partial.slice(partial.indexOf('id="dim-hygiene"'));
    expect(hygieneCard).not.toContain('class="fill"');
  });
});

describe("renderIncompleteHtml — incomplete report (1.2)", () => {
  it("renders incomplete notice, reason/errorCode, retry-after, local metrics, layer attribution, CTA", () => {
    const html = renderIncompleteHtml({
      errorCode: "over_quota",
      retryAfterSeconds: 30,
      metrics: METRICS,
      durationMs: 500,
      timestamp: "2026-09-07T12:00:00Z",
    });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("analysis incomplete");
    expect(html).toContain("over_quota");
    expect(html).toContain("30");
    expect(html.toLowerCase()).toContain("local metrics");
    expect(html).toContain("3/6");
    expect(html).toContain("@ram4_dev");
    expect(html.toLowerCase()).toContain("semantic layer did not complete");
  });

  it("retry-after omitted when absent", () => {
    const html = renderIncompleteHtml({
      errorCode: "timeout",
      metrics: METRICS,
      durationMs: 500,
      timestamp: "2026-09-07T12:00:00Z",
    });
    expect(html).toContain("timeout");
    expect(html).not.toContain("Retry-after");
  });

  it("never renders any score string (no /100, no Total score)", () => {
    const html = renderIncompleteHtml({
      errorCode: "invalid_model_response",
      metrics: METRICS,
      durationMs: 500,
      timestamp: "2026-09-07T12:00:00Z",
    });
    expect(html).not.toContain("Total score");
    expect(html).not.toContain("/100");
    expect(html).not.toMatch(/\bscore:\s*\d/i);
  });
});

describe("local metrics in complete report (root QA)", () => {
  it("surfaces ACTUAL local metric counts (tool calls resolved/errored, episodes)", () => {
    const html = completeHtml(COMPLETE, undefined, METRICS_WITH_SESSIONS);
    expect(html.toLowerCase()).toContain("tool calls");
    expect(html).toContain("16"); // 12 + 4 total
    expect(html).toContain("11"); // 9 + 2 resolved
    expect(html).toContain("2"); // 1 + 1 errored
    expect(html.toLowerCase()).toContain("episodes");
    expect(html).toContain("5"); // 3 + 2 episodes
  });

  it("digest coverage rendered separately with verbatim input values, only when supplied", () => {
    const without = completeHtml(COMPLETE);
    expect(without).not.toContain("samplingSelected");
    const withDigest = completeHtml(COMPLETE, { samplingSelected: 23, samplingOmitted: 41 });
    expect(withDigest).toContain("23");
    expect(withDigest).toContain("41");
    expect(withDigest.toLowerCase()).toContain("semantic sample");
  });

  it("empty sessions render honestly (not available), never fabricated zeros", () => {
    const html = completeHtml(COMPLETE);
    expect(html.toLowerCase()).toContain("not available");
  });
});

describe("numeric safety (root QA)", () => {
  it("never renders NaN/Infinity/out-of-range scores; renders honestly as not evaluable", () => {
    const bad = {
      ...COMPLETE,
      total: Number.NaN,
      dimensions: [
        { ...COMPLETE.dimensions[0]!, score: Number.NaN },
        { ...COMPLETE.dimensions[1]!, score: Number.POSITIVE_INFINITY },
        { ...COMPLETE.dimensions[2]!, score: 150 },
        { ...COMPLETE.dimensions[3]!, score: -5 },
        COMPLETE.dimensions[4]!,
      ],
    } as AnalyzeResponse;
    const html = completeHtml(bad);
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("Infinity");
    expect(html).not.toContain('style="width:150%"');
    // Invalid numeric scores render honestly as not evaluable (4 of 5).
    expect(html.match(/not evaluable/g) ?? []).toHaveLength(4);
    // An invalid total produces NO hero block.
    expect(html).not.toContain('class="hero"');
  });

  it("no hero when total is valid but any dimension is not evaluable (missing dimension ⇒ no total)", () => {
    const last = COMPLETE.dimensions[4]!;
    const { score: _invalidScore, ...lastRest } = last;
    const bad = {
      ...COMPLETE,
      total: 72.4, // valid total, but an unevaluable dimension below
      dimensions: [
        COMPLETE.dimensions[0]!,
        COMPLETE.dimensions[1]!,
        COMPLETE.dimensions[2]!,
        COMPLETE.dimensions[3]!,
        { ...lastRest, evaluable: false },
      ],
    } as AnalyzeResponse;
    const html = completeHtml(bad);
    expect(html).not.toContain('class="hero"');
    // The unevaluable card still renders honestly.
    expect(html).toContain("not evaluable");
  });
});

describe("escaping + presentation guarantees (1.3)", () => {
  const HOSTILE = `<script>alert(1)</script> & "quotes" 'apostrophes' <img src=x onerror=alert(2)>`;
  const HOSTILE_DIMS: AnalyzeDimensions = [
    {
      ...COMPLETE.dimensions[0]!,
      notes: HOSTILE,
      evidence: [{ sessionId: `<sess>&"id">`, line: 2 }],
    },
    COMPLETE.dimensions[1]!,
    COMPLETE.dimensions[2]!,
    COMPLETE.dimensions[3]!,
    COMPLETE.dimensions[4]!,
  ];
  const HOSTILE_COMPLETE: AnalyzeResponse = {
    ...COMPLETE,
    dimensions: HOSTILE_DIMS,
  };
  const hostileTimestamp = `2026-09-07T12:00:00Z<script>&"x"<`;

  it("hostile notes, evidence refs, errorCode and timestamps come out entity-escaped", () => {
    const complete = renderCompleteHtml({
      response: HOSTILE_COMPLETE,
      metrics: METRICS,
      durationMs: 1000,
      timestamp: hostileTimestamp,
    });
    const incomplete = renderIncompleteHtml({
      errorCode: HOSTILE,
      metrics: METRICS,
      durationMs: 1000,
      timestamp: hostileTimestamp,
    });
    for (const html of [complete, incomplete]) {
      // Raw metacharacter-bearing payload never survives verbatim.
      expect(html).not.toContain(`<script>alert(1)</script>`);
      // The hostile text is present in entity-escaped form.
      expect(html).toContain(
        "&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;quotes&quot; &#39;apostrophes&#39; &lt;img src=x onerror=alert(2)&gt;",
      );
      // Escaped hostile timestamp.
      expect(html).toContain("2026-09-07T12:00:00Z&lt;script&gt;&amp;&quot;x&quot;&lt;");
    }
    // Escaped hostile evidence reference (complete only).
    expect(complete).toContain("&lt;sess&gt;&amp;&quot;id&quot;&gt;:2");
  });

  it("no <script> element originating from report data exists in the document", () => {
    const html = renderCompleteHtml({
      response: HOSTILE_COMPLETE,
      metrics: METRICS,
      durationMs: 1000,
      timestamp: hostileTimestamp,
    });
    expect(html).not.toMatch(/<script[\s>]/i);
  });

  it("documents carry lang, reduced-motion block, print block, and zero external references", () => {
    const complete = completeHtml(COMPLETE);
    const incomplete = renderIncompleteHtml({
      errorCode: "timeout",
      metrics: METRICS,
      durationMs: 1000,
      timestamp: "2026-09-07T12:00:00Z",
    });
    for (const html of [complete, incomplete]) {
      expect(html).toContain('<html lang="en">');
      expect(html).toContain("prefers-reduced-motion: reduce");
      expect(html).toContain("@media print");
      // Inline CSS only: no external references of any kind.
      expect(html).not.toContain("http://");
      expect(html).not.toContain("https://");
      expect(html).not.toContain("@import");
      expect(html).not.toContain("<script");
      expect(html).not.toContain("<link");
    }
  });

  it("reduced-motion block disables animation while keeping content visible", () => {
    const html = completeHtml(COMPLETE);
    const block = html.slice(
      html.indexOf("@media (prefers-reduced-motion: reduce)"),
      html.indexOf("@media print"),
    );
    expect(block).toContain("animation: none");
    expect(block).toContain("transition: none");
    expect(block).toContain("opacity: 1");
    expect(block).toContain("visibility: visible");
    // Score-fill animation is also disabled.
    expect(block).toContain("ryf-fill");
  });

  it("CSS regression: overflow-wrap anywhere + min-width:0 guard against long-string overflow at 390px", () => {
    const html = completeHtml(COMPLETE);
    const style = html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>"));
    expect(style).toMatch(/body\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(style).toMatch(/\.evidence\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(style).toMatch(/code\s*\{[^}]*overflow-wrap:\s*anywhere/);
    // Grid/card children cannot force horizontal overflow.
    expect(style).toMatch(/\.card\s*\{[^}]*min-width:\s*0/);
    expect(style).toMatch(/\.cards\s*>\s*\*\s*\{[^}]*min-width:\s*0/);
  });
});

describe("presentation regression — flow-track hero + dimension rails (2.4)", () => {
  it("hero total renders as a measured flow-track rail whose fill matches the total width", () => {
    const html = completeHtml(COMPLETE);
    expect(html).toContain('class="flow-track"');
    expect(html).toContain('class="flow-track-fill"');
    expect(html).toContain('style="width:72.4%"');
    const heroPos = html.indexOf('class="hero"');
    expect(heroPos).toBeGreaterThan(-1);
    expect(html.indexOf('class="flow-track"')).toBeGreaterThan(heroPos);
    expect(heroPos).toBeLessThan(html.indexOf("Coverage"));
    expect(heroPos).toBeLessThan(html.indexOf("Layer attribution"));
  });

  it("evaluable dimension lanes wrap the score bar in a rail; unevaluable lanes never render a rail", () => {
    const html = completeHtml(COMPLETE);
    expect(html.match(/class="rail"/g) ?? []).toHaveLength(5);

    const partial = completeHtml(PARTIAL);
    const hygieneCard = partial.slice(partial.indexOf('id="dim-hygiene"'));
    expect(hygieneCard).not.toContain('class="rail"');
    expect(hygieneCard).not.toContain('class="fill"');
    expect(hygieneCard).not.toContain("/100");
  });

  it("digest sampling copy is honest: selected for analysis vs set-aside, never claims the model scored each", () => {
    const without = completeHtml(COMPLETE);
    expect(without).not.toContain("set aside");
    const withDigest = completeHtml(COMPLETE, { samplingSelected: 50, samplingOmitted: 70 });
    expect(withDigest).toContain("set aside");
    expect(withDigest).toContain("latest 50 sessions");
    expect(withDigest).toContain("selected for semantic analysis");
    expect(withDigest).not.toContain("model scored");
    expect(withDigest.toLowerCase()).toContain("semantic sample");
  });
});

    describe("information hierarchy — visible snapshot, aligned lanes, one priority area (visual design)", () => {
      it("keeps the compact coverage + local-metrics snapshot visible, not behind the collapsed disclosure", () => {
        const html = completeHtml(COMPLETE);
        const snapshotPos = html.indexOf('class="snapshot"');
        const detailsPos = html.indexOf("<details");
        expect(snapshotPos).toBeGreaterThan(-1);
        expect(snapshotPos).toBeLessThan(detailsPos);
        // Snapshot carries the key local metrics + coverage verbatim.
        expect(html).toContain("3/6");
        expect(html.toLowerCase()).toContain("tool calls");
        expect(html.toLowerCase()).toContain("episodes");
      });

      it("collapses only the secondary provenance into a keyboard-accessible details disclosure", () => {
        const html = completeHtml(COMPLETE);
        expect(html).toContain("<details");
        expect(html).toContain("<summary>Provenance</summary>");
        const detailsBlock = html.slice(html.indexOf("<details"), html.indexOf("</details>"));
        expect(detailsBlock).toContain("Layer attribution");
        // The primary snapshot is outside the disclosure.
        const snapshotBlock = html.slice(html.indexOf('class="snapshot"'), html.indexOf("<details"));
        expect(snapshotBlock).not.toContain("Layer attribution");
      });

      it("renders aligned comparison lanes (name | rail | score); the note lives only in the priority area", () => {
        const html = completeHtml(COMPLETE);
        expect(html.match(/class="card"/g) ?? []).toHaveLength(5);
        expect(html.match(/class="lane"/g) ?? []).toHaveLength(5);
        expect(html.match(/class="rail"/g) ?? []).toHaveLength(5);
        expect(html).toContain('class="lane-name"');
        expect(html).toContain('class="lane-score"');
        // Clean comparison: the note is NOT repeated in the lane.
        const reliabilityCard = html.slice(
          html.indexOf('id="dim-reliability"'),
          html.indexOf('id="dim-communication"'),
        );
        expect(reliabilityCard).not.toContain("mostly verified completions");
      });

      it("consolidates the model's guidance into ONE prioritized action area, weakest score first", () => {
        const html = completeHtml(COMPLETE);
        const priorityPos = html.indexOf("Priority");
        const snapshotPos = html.indexOf('class="snapshot"');
        expect(priorityPos).toBeGreaterThan(-1);
        const priorityBlock = html.slice(priorityPos, snapshotPos);
        // Notes appear (once) here, and weakest dimension (productivity 55) leads.
        expect(priorityBlock).toContain("mostly verified completions");
        expect(priorityBlock).toContain("productivity");
        expect(priorityBlock.indexOf("productivity")).toBeLessThan(priorityBlock.indexOf("communication"));
        // No generic duplicate sections that merely re-list the weakest names.
        expect(html).not.toContain(">Diagnosis<");
        expect(html).not.toContain(">Recommendations<");
      });

      it("forces the collapsed disclosure content to print under print media", () => {
            const html = completeHtml(COMPLETE);
            const style = html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>"));
            const printBlock = style.slice(style.indexOf("@media print"), style.indexOf("@media (max-width: 480px)"));
            expect(printBlock).toContain("details");
            expect(printBlock).toContain(":not(summary)");
            // Chromium hides closed <details> content in print via its default
            // ::details-content { content-visibility: hidden }; the rule must force it
            // visible so the provenance disclosure content prints when collapsed (a
            // DOM-height-only check misses this — assert the actual print rule).
            expect(printBlock).toContain("details::details-content");
            expect(printBlock).toContain("content-visibility: visible");
            // Scoping guard: the visibility-forcing rule is exclusive to print —
            // it never appears outside the @media print block (a rule added to the
            // screen styles would change on-screen behavior, not fix print).
            const prePrint = style.slice(0, style.indexOf("@media print"));
            expect(prePrint).not.toContain("details::details-content");
          });
    });

describe("incomplete report — plain actionable copy + no-score invariant (root review)", () => {
  const INCOMPLETE_BASE = {
    metrics: METRICS,
    durationMs: 500,
    timestamp: "2026-09-07T12:00:00Z",
  };

  it("endpoint_not_configured leads with actionable setup instructions and puts the error code in a secondary technical line", () => {
    const html = renderIncompleteHtml({ errorCode: "endpoint_not_configured", ...INCOMPLETE_BASE });
    expect(html.toLowerCase()).toContain("analysis incomplete");
    expect(html).toContain("RYF_ENDPOINT");
    expect(html).toContain("ryf --endpoint");
    expect(html).toContain("consent");
    expect(html).toContain("Technical details");
    expect(html).toContain("endpoint_not_configured");
    // No score is ever rendered for an incomplete report.
    expect(html).not.toContain("/100");
    expect(html).not.toContain("Total score");
    expect(html).not.toMatch(/\bscore:\s*\d/i);
  });

  it("endpoint_unreachable leads with actionable backend-check guidance and never scores", () => {
    const html = renderIncompleteHtml({ errorCode: "endpoint_unreachable", ...INCOMPLETE_BASE });
    expect(html.toLowerCase()).toContain("analysis incomplete");
    expect(html).toContain("reachable");
    expect(html).toContain("PORT");
    expect(html).toContain("provider service");
    expect(html).toContain("Technical details");
    expect(html).toContain("endpoint_unreachable");
    expect(html).not.toContain("/100");
    expect(html).not.toContain("Total score");
    expect(html).not.toMatch(/\bscore:\s*\d/i);
  });

          it("unknown error codes stay compact: plain guidance + secondary Technical details, never a headline score", () => {
            const html = renderIncompleteHtml({ errorCode: "provider_unavailable", ...INCOMPLETE_BASE });
            expect(html).toContain("could not be completed");
            expect(html).toContain("Technical details");
            expect(html).toContain("provider_unavailable");
            expect(html).not.toContain("/100");
            expect(html).not.toContain("Total score");
            expect(html).not.toMatch(/\bscore:\s*\d/i);
          });
        });
