/**
 * HttpProviderStub — deterministic local provider adapter for E2E
 * (design D4). Schema-valid responses including 429/402/invalid simulations;
 * honors the caller's abort signal (timeout path); never touches the network.
 */

import { DIMENSIONS } from "../../shared/contracts/index.js";
import type { DimensionScore, DigestV1 } from "../../shared/contracts/index.js";
import {
  ProviderFailure,
  type AnalysisProvider,
  type ProviderOptions,
  type ProviderResult,
} from "../types.js";

export interface HttpProviderStubOptions {
  mode?: "ok" | "rate_limited" | "payment_required" | "invalid" | "hang";
  /** Simulated provider latency before responding (except hang). */
  delayMs?: number;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderFailure("timeout", "provider call aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new ProviderFailure("timeout", "provider call aborted"));
      },
      { once: true },
    );
  });
}

export class HttpProviderStub implements AnalysisProvider {
  readonly name = "stub";

  constructor(private readonly options: HttpProviderStubOptions = {}) {}

  async analyze(digest: DigestV1, options: ProviderOptions): Promise<ProviderResult> {
    const mode = this.options.mode ?? "ok";
    if (this.options.delayMs !== undefined || mode === "hang") {
      // hang waits until aborted (or a very long default); delay waits once.
      const waitMs = mode === "hang" ? 60_000 : (this.options.delayMs ?? 0);
      await delay(waitMs, options.signal);
    }

    switch (mode) {
      case "rate_limited":
        throw new ProviderFailure("over_quota", "stub: provider rate limited", 45);
      case "payment_required":
        throw new ProviderFailure("payment_required", "stub: payment required");
      case "hang":
        // Signal aborts above; otherwise never resolves.
        return new Promise<ProviderResult>(() => undefined);
      default:
        break;
    }

    // Deterministic valid output: cite the first digest reference of each
    // session (resolvable); no refs ⇒ not evaluable, never fabricated scores.
    const firstRefs = digest.eventSequences
      .map((sequence) => {
        const first = sequence.events[0];
        return first === undefined ? null : { sessionId: sequence.sessionId, line: first.line };
      })
      .filter((ref) => ref !== null);
    const fallbackRef = digest.citedSnippets[0];
    const evidence =
      firstRefs.length > 0
        ? firstRefs
        : fallbackRef !== undefined
          ? [{ sessionId: fallbackRef.sessionId, line: fallbackRef.line }]
          : [];

    const dimensions: DimensionScore[] = DIMENSIONS.map((dimension, index) => {
      if (mode === "invalid") {
        // Deliberate garbage: out-of-range score + unresolvable citation.
        return {
          dimension,
          score: 150,
          evaluable: true,
          evidence: [{ sessionId: "ghost", line: 999 }],
          notes: `invalid ${dimension}`,
        };
      }
      const evaluable = evidence.length > 0;
      const base = {
        dimension,
        evaluable,
        evidence,
        notes: `stub assessment for ${dimension}`,
      };
      return evaluable ? { ...base, score: 50 + index * 5 } : base;
    });

    return { dimensions, confidenceNote: "stub: descriptive confidence only" };
  }
}
