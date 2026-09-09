/**
 * Provider response validation (scoring spec: "Score and citation validation").
 *
 * A provider result is accepted only when:
 * - it contains exactly the five rubric dimensions, in contract order;
 * - each evaluable dimension carries a finite numeric score in 0..100;
 * - each not-evaluable dimension carries NO score (never fabricated);
 * - every citation resolves to a digest reference (sessionId + line present
 *   in that session's eventSequence or citedSnippets);
 * - every evaluable dimension carries at least one resolvable citation.
 *
 * Failures map to the `invalid_model_response` error code upstream.
 */

import type { DigestV1, DimensionScore, EvidenceRef } from "../../shared/contracts/index.js";
import { DIMENSIONS } from "../../shared/contracts/index.js";

export type ValidationResult = { ok: true } | { ok: false; reason: string };

/**
 * Builds a resolver for digest references: sessionId+line must exist in the
 * session's eventSequence event lines or citedSnippets lines.
 */
export function digestRefLookup(digest: DigestV1): (sessionId: string, line: number) => boolean {
  const refs = new Set<string>();
  for (const sequence of digest.eventSequences) {
    for (const event of sequence.events) {
      refs.add(`${sequence.sessionId}#${event.line}`);
    }
  }
  for (const snippet of digest.citedSnippets) {
    refs.add(`${snippet.sessionId}#${snippet.line}`);
  }
  return (sessionId: string, line: number) => refs.has(`${sessionId}#${line}`);
}

export function validateProviderResult(
  result: { dimensions: DimensionScore[]; confidenceNote: string },
  digest: DigestV1,
): ValidationResult {
  const dimensions = result.dimensions;
  if (!Array.isArray(dimensions) || dimensions.length !== DIMENSIONS.length) {
    return { ok: false, reason: `expected ${DIMENSIONS.length} dimensions` };
  }
  const resolves = digestRefLookup(digest);

  for (let index = 0; index < DIMENSIONS.length; index++) {
    const expected = DIMENSIONS[index]!;
    const dimension = dimensions[index]!;
    if (dimension.dimension !== expected) {
      return { ok: false, reason: `dimension ${index}: expected ${expected}` };
    }
    if (typeof dimension.evaluable !== "boolean") {
      return { ok: false, reason: `${expected}: evaluable must be boolean` };
    }

    if (dimension.evaluable) {
      const score = (dimension as { score?: unknown }).score;
      if (typeof score !== "number" || !Number.isFinite(score)) {
        return { ok: false, reason: `${expected}: evaluable requires numeric score` };
      }
      if (score < 0 || score > 100) {
        return { ok: false, reason: `${expected}: score ${score} outside 0-100` };
      }
      const evidence = dimension.evidence;
      if (!Array.isArray(evidence) || evidence.length === 0) {
        return { ok: false, reason: `${expected}: evaluable requires evidence` };
      }
      for (const ref of evidence as EvidenceRef[]) {
        if (
          typeof ref?.sessionId !== "string" ||
          typeof ref?.line !== "number" ||
          !resolves(ref.sessionId, ref.line)
        ) {
          return {
            ok: false,
            reason: `${expected}: citation ${JSON.stringify(ref)} does not resolve`,
          };
        }
      }
    } else if ((dimension as { score?: unknown }).score !== undefined) {
      // Not evaluable: a numeric score must never be fabricated.
      return { ok: false, reason: `${expected}: not-evaluable must not carry a score` };
    }
  }
  return { ok: true };
}
