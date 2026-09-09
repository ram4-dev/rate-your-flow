/**
 * Codex token summary — honest counts-only surface (root review; supersedes
 * the U2b global gate and the U2c semantics-verification design).
 *
 * Synthetic fixtures cannot establish the REAL Codex accumulation semantics
 * (delta vs cumulative) — that would be circular. Runtime token summaries are
 * therefore UNVERIFIED by construction:
 * - thread snapshots: the LATEST RAW snapshot is retained (with caveat); no
 *   derived aggregates over thread records.
 * - turn records: surfaced as individual per-record counts; NEVER summed
 *   (summing cumulative snapshots would overcount).
 * - plain usage records: elementwise sum is provided but explicitly flagged
 *   unverified (it assumes per-record semantics, itself unconfirmed).
 * - There is NO module-global trust state and no throw: every summary carries
 *   `unverified: true` with fixed-phrase warnings. Repeated identical turn
 *   snapshots never inflate anything (no summation; per-record list only).
 * - Warnings carry session ids and fixed English phrases only — never raw
 *   line content (privacy).
 */
import type { Session, TokenEvent } from "./model.js";

const TOTAL_KEY = "total_tokens";

export interface TokenSummary {
  /** Always false in v1: no aggregate token semantics are verified. */
  verified: false;
  /** Always true in v1: aggregate inference is not performed. */
  countsOnly: true;
  /** Fixed caveat from TOKEN_SHAPE_POLICY (never implies external truth). */
  caveat: string;
  warnings: string[];
  /** Latest RAW thread snapshot, retained verbatim with caveat. */
  threadSnapshot?: Record<string, number>;
  /** Per-turn record counts, in source order — NOT summed. */
  turnCounts: Record<string, number>[];
  /**
   * Elementwise sum of plain usage records, flagged unverified (assumes
   * per-record semantics, unconfirmed).
   */
  usageTotals?: Record<string, number>;
}

/** Latest event by its total (raw snapshot retention, no aggregation). */
function latestByTotal(events: TokenEvent[]): TokenEvent | undefined {
  let best: TokenEvent | undefined;
  for (const event of events) {
    if (best === undefined || (event.counts[TOTAL_KEY] ?? 0) >= (best.counts[TOTAL_KEY] ?? 0)) {
      best = event;
    }
  }
  return best;
}

function elementwiseSum(events: TokenEvent[]): Record<string, number> {
  const sums: Record<string, number> = {};
  for (const event of events) {
    for (const [key, count] of Object.entries(event.counts)) {
      sums[key] = (sums[key] ?? 0) + count;
    }
  }
  return sums;
}

/**
 * Build the honest counts-only token summary for ONE session (no global
 * state; an unrelated session can never inherit another session's state).
 */
export function summarizeTokenUsage(session: Session): TokenSummary {
  const warnings: string[] = [];
  const thread: TokenEvent[] = [];
  const turns: TokenEvent[] = [];
  let sawLegacy = false;

  for (const event of session.tokenEvents) {
    if (event.recordType === "usage") {
      continue;
    }
    if (event.legacyShape === true) {
      sawLegacy = true;
      continue;
    }
    if (event.recordType === "thread_token_usage") {
      thread.push(event);
    } else {
      turns.push(event);
    }
  }

  if (sawLegacy) {
    warnings.push(
      `${session.sessionId || session.filePath}: legacy separate-type token records are unverified (nested shape required)`,
    );
  }

  const summary: TokenSummary = {
    verified: false,
    countsOnly: true,
    caveat:
      "token accumulation semantics unverified; thread snapshot retained raw, turn records not summed",
    warnings,
    turnCounts: turns.map((event) => event.counts),
  };

  const latest = latestByTotal(thread);
  if (latest !== undefined) {
    summary.threadSnapshot = latest.counts;
  }
  const usage = session.tokenEvents.filter((event) => event.recordType === "usage");
  if (usage.length > 0) {
    summary.usageTotals = elementwiseSum(usage);
    warnings.push(
      `${session.sessionId || session.filePath}: usage totals assume per-record semantics (unverified)`,
    );
  }
  return summary;
}
