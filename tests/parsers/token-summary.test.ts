/**
 * Codex token summary — honest counts-only contract (root review; supersedes
 * the U2c semantics-verification design, which was circular: synthetic
 * fixtures cannot establish the real Codex accumulation semantics).
 *
 * Contract under test:
 * - Summaries are counts-only/unverified by construction; provenance never
 *   implies an externally verified truth.
 * - Latest RAW thread snapshot retained with caveat; turn records surfaced
 *   per-record, NEVER summed (no overcount on repeated identical snapshots).
 * - No module-global trust state: session B never inherits session A.
 * - Legacy separate-type records stay flagged unverified.
 * - Warnings never embed raw line content.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCodexSession } from "../../src/cli/parsers/codex@1.js";
import { TOKEN_SHAPE_POLICY } from "../../src/cli/parsers/token-semantics.js";
import { summarizeTokenUsage } from "../../src/cli/parsers/token-gate.js";

const PATH = (name: string): string =>
  fileURLToPath(new URL(`../fixtures/parsers/codex/${name}`, import.meta.url));

describe("codex token summary — honest counts-only (root review)", () => {
  it("policy records honest uncertainty; provenance never claims external truth", () => {
    expect(TOKEN_SHAPE_POLICY.status).toBe("unverified");
    expect(TOKEN_SHAPE_POLICY.hypothesis.threadKind).toBe("unknown");
    expect(TOKEN_SHAPE_POLICY.hypothesis.turnKind).toBe("unknown");
    expect(TOKEN_SHAPE_POLICY.provenance).not.toContain("fixture-proven");
    expect(TOKEN_SHAPE_POLICY.provenance).toContain("unverified");
  });

  it("latest raw thread snapshot retained; turn records per-record and NOT summed", async () => {
    const session = await parseCodexSession(PATH("token-usage-delta.jsonl"));
    const summary = summarizeTokenUsage(session);
    expect(summary.verified).toBe(false);
    expect(summary.countsOnly).toBe(true);
    expect(summary.caveat).toContain("unverified");
    // Raw latest thread snapshot (410) — retained verbatim, not derived.
    expect(summary.threadSnapshot?.total_tokens).toBe(410);
    // Turn records per-record in source order, NOT summed.
    expect(summary.turnCounts).toEqual([
      expect.objectContaining({ total_tokens: 100 }),
      expect.objectContaining({ total_tokens: 310 }),
    ]);
  });

  it("no overcount on repeated identical turn snapshots (no summation)", async () => {
    const session = await parseCodexSession(PATH("token-usage-delta.jsonl"));
    const summary = summarizeTokenUsage(session);
    // Even if both turn records were identical snapshots, the surface is a
    // per-record list — there is no aggregate that could inflate it.
    expect(summary.turnCounts).toHaveLength(2);
    expect(summary.verified).toBe(false);
  });

  it("no global trust leakage: usage-only session B carries no claim of its own (A-then-B regression)", async () => {
    const a = await parseCodexSession(PATH("token-usage-delta.jsonl"));
    const b = await parseCodexSession(PATH("valid.jsonl"));
    const aSummary = summarizeTokenUsage(a);
    expect(aSummary.threadSnapshot?.total_tokens).toBe(410);
    const bSummary = summarizeTokenUsage(b);
    // usage-only session: usage totals flagged unverified; NO thread/turn claim.
    expect(bSummary.threadSnapshot).toBeUndefined();
    expect(bSummary.turnCounts).toHaveLength(0);
    expect(bSummary.usageTotals?.total_tokens).toBe(165);
    expect(bSummary.verified).toBe(false);
  });

  it("legacy separate-type records: flagged unverified, excluded from snapshot/turns", async () => {
    const session = await parseCodexSession(PATH("tokens-accumulated.jsonl"));
    const summary = summarizeTokenUsage(session);
    expect(summary.verified).toBe(false);
    expect(summary.threadSnapshot).toBeUndefined();
    expect(summary.turnCounts).toHaveLength(0);
    expect(summary.warnings.some((w) => w.includes("legacy"))).toBe(true);
  });

  it("ambiguous nested records: still honest counts-only, numbers surfaced per-record", async () => {
    const session = await parseCodexSession(PATH("token-usage-ambiguous-nested.jsonl"));
    const summary = summarizeTokenUsage(session);
    expect(summary.verified).toBe(false);
    expect(summary.countsOnly).toBe(true);
    expect(summary.threadSnapshot?.total_tokens).toBe(100);
    expect(summary.turnCounts).toHaveLength(1);
  });
});
