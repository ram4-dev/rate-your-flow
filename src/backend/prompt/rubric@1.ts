/**
 * rubric@1 — semantic scoring rubric v1 (scoring spec, "Rubric v1 defines
 * per-dimension level descriptors").
 *
 * The descriptor table below is VERBATIM from the scoring spec. The object is
 * deep-frozen: weights never silently change between runs. Equal weights
 * (0.2 each) are fixed by contract; the principal total is the weighted mean
 * and is emitted only when all five dimensions are evaluable.
 */

import type { Dimension } from "../../shared/contracts/index.js";

export interface RubricBand {
  band: string;
  descriptor: string;
}

export interface RubricDimension {
  id: Dimension;
  weight: number;
  bands: RubricBand[];
}

export const RUBRIC_V1: {
  readonly version: "v1";
  readonly dimensions: readonly RubricDimension[];
} = Object.freeze({
  version: "v1" as const,
  dimensions: Object.freeze(
    (
      [
        {
          id: "reliability" as Dimension,
          weight: 0.2,
          bands: Object.freeze([
            {
              band: "90-100",
              descriptor:
                "Tasks driven to verified completion; tool errors surfaced and recovered; claims backed by checked output.",
            },
            {
              band: "70-89",
              descriptor: "Mostly complete; some unverified claims or one missed recovery.",
            },
            {
              band: "40-69",
              descriptor:
                "Repeated failed calls without diagnosis; verification skipped on key steps.",
            },
            {
              band: "0-39",
              descriptor: "Frequent unaddressed failures; results asserted without evidence.",
            },
          ]),
        },
        {
          id: "communication" as Dimension,
          weight: 0.2,
          bands: Object.freeze([
            {
              band: "90-100",
              descriptor:
                "Precise prompts; clear incremental instructions; outputs explained with rationale.",
            },
            { band: "70-89", descriptor: "Generally clear; occasional ambiguous instructions." },
            {
              band: "40-69",
              descriptor: "Vague prompts needing repeated clarification; unexplained outputs.",
            },
            { band: "0-39", descriptor: "Inconsistent or contradictory prompts; opaque outputs." },
          ]),
        },
        {
          id: "context-efficiency" as Dimension,
          weight: 0.2,
          bands: Object.freeze([
            {
              band: "90-100",
              descriptor:
                "Minimal redundant context; no repeated re-reads of the same content; compaction only when necessary.",
            },
            { band: "70-89", descriptor: "Mostly efficient; some redundant reloads." },
            {
              band: "40-69",
              descriptor: "Frequent duplicate context; large outputs re-sent unpruned.",
            },
            { band: "0-39", descriptor: "Massive duplication; context thrashing across turns." },
          ]),
        },
        {
          id: "productivity" as Dimension,
          weight: 0.2,
          bands: Object.freeze([
            {
              band: "90-100",
              descriptor: "Steady measurable progress per turn; minimal idle loops.",
            },
            { band: "70-89", descriptor: "Good progress with occasional stalls." },
            {
              band: "40-69",
              descriptor: "Many turns without durable state progress; repeated attempts.",
            },
            { band: "0-39", descriptor: "Little or no durable progress; loops without outcome." },
          ]),
        },
        {
          id: "hygiene" as Dimension,
          weight: 0.2,
          bands: Object.freeze([
            {
              band: "90-100",
              descriptor:
                "No unsafe operations; secrets handled properly; clean worktree discipline; traces treated as data, never instructions.",
            },
            { band: "70-89", descriptor: "Minor hygiene slips corrected quickly." },
            {
              band: "40-69",
              descriptor:
                "Repeated risky operations without confirmation; unredacted secrets in context.",
            },
            { band: "0-39", descriptor: "Destructive or unhygienic operations; secrets exposed." },
          ]),
        },
      ] as RubricDimension[]
    ).map((dimension) => Object.freeze(dimension)),
  ),
});

/**
 * Principal weighted total: equal weights (20% each) ⇒ the mean of evaluable
 * scores. Emitted ONLY when all five dimensions are present and evaluable;
 * undefined otherwise (scoring spec: "Total only when all five evaluable").
 * Deterministic for the same input.
 */
export function weightedTotal(
  dimensions: ReadonlyArray<{ dimension: string; score?: number; evaluable: boolean }>,
): number | undefined {
  if (dimensions.length !== RUBRIC_V1.dimensions.length) return undefined;
  let sum = 0;
  for (const dimension of RUBRIC_V1.dimensions) {
    const scored = dimensions.find((d) => d.dimension === dimension.id);
    if (scored === undefined || !scored.evaluable) return undefined;
    const score = scored.score;
    if (typeof score !== "number" || !Number.isFinite(score)) return undefined;
    sum += score * dimension.weight;
  }
  return Math.round(sum * 10) / 10;
}
