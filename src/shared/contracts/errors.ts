/**
 * analysis@1 error envelope — explicit degradation outcomes.
 *
 * Any of these codes means: no score was produced; the CLI degrades to local
 * metrics with an explicit incomplete-analysis notice. Never a fabricated
 * score, never a paid fallback.
 */

import type { AnalysisSchema } from "./analysis@1.js";

/** Exhaustive error-code set for the analysis@1 incomplete outcome. */
export const ANALYSIS_ERROR_CODES = [
  "over_quota",
  "payment_required",
  "timeout",
  "quota_exhausted",
  "cost_ceiling",
  "oversized_payload",
  "endpoint_unreachable",
  "endpoint_redirected",
  "provider_unavailable",
  "invalid_model_response",
] as const;

export type AnalysisErrorCode = (typeof ANALYSIS_ERROR_CODES)[number];

export interface AnalyzeErrorPayload {
  code: AnalysisErrorCode;
  /** Present when the upstream signaled `retry-after` (429/402 passthrough). */
  retryAfterSeconds?: number;
}

/** Backend → CLI failure response. */
export interface AnalyzeError {
  schema: AnalysisSchema;
  outcome: "incomplete";
  error: AnalyzeErrorPayload;
}
