/**
 * Codex token-shape model (root review: synthetic fixtures CANNOT establish
 * the real Codex accumulation semantics — pinning delta-vs-cumulative from
 * generated fixtures is circular).
 *
 * This module documents the OBSERVED SHAPE only, with honest uncertainty:
 * - token_usage_record payload carries nested usage/thread_token_usage/
 *   turn_token_usage (nested shape confirmed by corpus census).
 * - The semantics of nested thread/turn fields (cumulative snapshots vs
 *   per-turn deltas) are NOT established by any authoritative format/source
 *   evidence available in this change. Runtime token summaries are therefore
 *   counts-only/unverified.
 *
 * Runtime code reads only this constant; test fixtures never load at runtime.
 */

export interface TokenShapePolicy {
  version: 1;
  /**
   * Honest status: the accumulation semantics are UNVERIFIED. Aggregate
   * inference (sums over thread/turn records) is NOT performed; latest raw
   * thread snapshots are retained with a caveat.
   */
  status: "unverified";
  /**
   * Documented hypothesis only (NOT a proven claim): thread snapshots look
   * cumulative and turn fields look per-turn, but this is unconfirmed.
   */
  hypothesis: {
    threadKind: "cumulative" | "per-turn-delta" | "unknown";
    turnKind: "cumulative" | "per-turn-delta" | "unknown";
  };
  /**
   * Provenance states exactly what is known and how — it must never imply an
   * externally verified truth ("fixture-proven" was rejected as circular).
   */
  provenance: string;
}

export const TOKEN_SHAPE_POLICY: TokenShapePolicy = {
  version: 1,
  status: "unverified",
  hypothesis: { threadKind: "unknown", turnKind: "unknown" },
  provenance:
    "nested shape confirmed by corpus census; accumulation semantics unverified (no authoritative format evidence in this change)",
};
