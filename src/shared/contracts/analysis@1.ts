/**
 * analysis@1 — public analysis contract types.
 *
 * Stable regardless of which provider adapter is configured (see
 * analysis-backend spec). Imports the digest contract from digest@1.
 */

import type { DigestV1 } from "./digest@1.js";

export const ANALYSIS_SCHEMA = "analysis@1" as const;
export type AnalysisSchema = typeof ANALYSIS_SCHEMA;

/** Rubric v1 dimensions, in scoring-spec order. */
export const DIMENSIONS = [
  "reliability",
  "communication",
  "context-efficiency",
  "productivity",
  "hygiene",
] as const;

export type Dimension = (typeof DIMENSIONS)[number];

/** Evidence citation: resolves to a digest reference (session + line). */
export interface EvidenceRef {
  sessionId: string;
  line: number;
}

/** One scored dimension. `score` present only when evaluable. */
export interface DimensionScore {
  dimension: Dimension;
  /** 0–100 when evaluable; absent when the dimension is not evaluable. */
  score?: number;
  evaluable: boolean;
  evidence: EvidenceRef[];
  notes: string;
}

/** Exactly five scored dimensions (one per rubric dimension, in order). */
export type AnalyzeDimensions = readonly [
  DimensionScore,
  DimensionScore,
  DimensionScore,
  DimensionScore,
  DimensionScore,
];

/** CLI → backend request envelope. */
export interface AnalyzeRequest {
  schema: AnalysisSchema;
  installUUID: string;
  digest: DigestV1;
}

/** Backend → CLI success response (all five dimensions assessed). */
export interface AnalyzeResponse {
  schema: AnalysisSchema;
  outcome: "complete";
  dimensions: AnalyzeDimensions;
  /** Principal weighted total — emitted only when 5/5 dimensions are evaluable. */
  total?: number;
  /** Descriptive confidence note only; never a calibrated probability. */
  confidenceNote: string;
}
