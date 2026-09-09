/**
 * analysis@1 handler (Phase 6, tasks 6.1/6.2): stable public contract
 * regardless of the configured provider adapter.
 *
 * Flow: size guard → envelope/schema validation → atomic reserve (quota +
 * concurrency) → optional cost-ceiling check → provider call with timeout
 * (abort signal) → response assembly (total only at 5/5 evaluable). Any
 * failure releases the reservation (lease-owned, idempotent) and returns the
 * analysis@1 error envelope; never a fabricated score, never a paid fallback.
 * Stateless: digest content is never persisted anywhere (counters are
 * metadata-only).
 */

import {
  DIMENSIONS,
  type AnalyzeError,
  type AnalyzeResponse,
  type DigestV1,
  type DimensionScore,
  type EvidenceRef,
} from "../shared/contracts/index.js";
import { DEFAULT_BACKEND_CONFIG, utcDay, type BackendConfig } from "./config.js";
import {
  ProviderFailure,
  type AnalysisProvider,
  type CounterStore,
  type ProviderResult,
} from "./types.js";
import { validateProviderResult } from "./providers/validate.js";
import { weightedTotal } from "./prompt/rubric@1.js";

export interface HandlerDeps {
  store: CounterStore;
  provider: AnalysisProvider;
  config: BackendConfig;
  /** Epoch ms provider; injected for determinism in tests. */
  now?: () => number;
}

export type HandlerResult = AnalyzeResponse | AnalyzeError;
export type { AnalysisProvider, CounterStore };
export { DEFAULT_BACKEND_CONFIG, utcDay };
export type { ProviderFailure, BackendConfig, DimensionScore, EvidenceRef, DigestV1 };

const SCHEMA = "analysis@1";
const DIGEST_SCHEMA = "digest@1";

function incomplete(code: AnalyzeError["error"]["code"], retryAfterSeconds?: number): AnalyzeError {
  const error: AnalyzeError["error"] = { code };
  // exactOptionalPropertyTypes: set only when present.
  if (retryAfterSeconds !== undefined) error.retryAfterSeconds = retryAfterSeconds;
  return { schema: SCHEMA, outcome: "incomplete", error };
}

function isPositiveSafeInt(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Pre-provider digest shape validation (type guard): the schema tag alone is
 * not enough — malformed arrays/counters/line refs must never reach a provider
 * call.
 */
function digestShapeIsValid(digest: unknown): digest is DigestV1 {
  if (typeof digest !== "object" || digest === null) return false;
  const d = digest as {
    schema?: unknown;
    counters?: unknown;
    eventSequences?: unknown;
    episodes?: unknown;
    citedSnippets?: unknown;
  };
  if (d.schema !== DIGEST_SCHEMA) return false;
  if (typeof d.counters !== "object" || d.counters === null) return false;
  for (const value of Object.values(d.counters as Record<string, unknown>)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return false;
  }
  if (
    !Array.isArray(d.eventSequences) ||
    !Array.isArray(d.episodes) ||
    !Array.isArray(d.citedSnippets)
  ) {
    return false;
  }
  for (const sequence of d.eventSequences as unknown[]) {
    if (typeof sequence !== "object" || sequence === null) return false;
    const seq = sequence as { sessionId?: unknown; events?: unknown };
    if (typeof seq.sessionId !== "string" || seq.sessionId.length === 0) return false;
    if (!Array.isArray(seq.events)) return false;
    for (const event of seq.events as unknown[]) {
      if (typeof event !== "object" || event === null) return false;
      const ev = event as { line?: unknown; kind?: unknown };
      if (!isPositiveSafeInt(ev.line)) return false; // bounded line refs
      if (typeof ev.kind !== "string") return false;
    }
  }
  for (const episode of d.episodes as unknown[]) {
    if (typeof episode !== "object" || episode === null) return false;
    const ep = episode as {
      sessionId?: unknown;
      startLine?: unknown;
      endLine?: unknown;
      summary?: unknown;
    };
    if (typeof ep.sessionId !== "string" || ep.sessionId.length === 0) return false;
    if (!isPositiveSafeInt(ep.startLine) || !isPositiveSafeInt(ep.endLine)) return false;
    if (typeof ep.summary !== "string") return false;
  }
  for (const snippet of d.citedSnippets as unknown[]) {
    if (typeof snippet !== "object" || snippet === null) return false;
    const sn = snippet as { sessionId?: unknown; line?: unknown; text?: unknown };
    if (typeof sn.sessionId !== "string" || sn.sessionId.length === 0) return false;
    if (!isPositiveSafeInt(sn.line)) return false;
    if (typeof sn.text !== "string") return false;
  }
  return true;
}

export function createAnalysisHandler(deps: HandlerDeps): {
  handle: (rawEnvelope: string) => Promise<HandlerResult>;
} {
  const now = deps.now ?? Date.now;
  const config = deps.config;

  const handle = async (rawEnvelope: string): Promise<HandlerResult> => {
    // 1. Size guard BEFORE any parse/provider work.
    if (Buffer.byteLength(rawEnvelope, "utf8") > config.maxPayloadBytes) {
      return incomplete("oversized_payload");
    }

    // 2. Envelope/schema validation.
    let envelope: { schema?: unknown; installUUID?: unknown; digest?: unknown };
    try {
      envelope = JSON.parse(rawEnvelope) as typeof envelope;
    } catch {
      // Contract gap (reported): no dedicated request-error code exists in the
      // shared envelope yet; "invalid_model_response" is the in-contract
      // "invalid payload" code until contracts add "invalid_request".
      return incomplete("invalid_model_response");
    }
    if (typeof envelope !== "object" || envelope === null || Array.isArray(envelope)) {
      // JSON null / arrays / primitives parse successfully but crash naive
      // field access — treat as invalid payload.
      return incomplete("invalid_model_response");
    }
    if (
      envelope.schema !== SCHEMA ||
      typeof envelope.installUUID !== "string" ||
      envelope.installUUID.length === 0
    ) {
      return incomplete("invalid_model_response");
    }
    const digest = envelope.digest as DigestV1 | undefined;
    if (!digestShapeIsValid(digest)) {
      return incomplete("invalid_model_response");
    }

    // 3. Atomic reserve (quota + concurrency) — release is lease-owned and
    // idempotent, so failure paths can release() safely. A store outage
    // (e.g. Redis down) must degrade in-contract, never reject the call.
    const nowMs = now();
    const day = utcDay(nowMs);
    let reservation;
    try {
      reservation = await deps.store.reserve({
        installUUID: envelope.installUUID,
        utcDay: day,
        now: nowMs,
        reservationTtlMs: config.timeoutMs + 5_000,
      });
    } catch (error) {
      void error; // safe errors: never leak store internals
      return incomplete("provider_unavailable");
    }
    if (!reservation.ok) {
      return incomplete("over_quota");
    }

    const releaseForFailure = async (): Promise<void> => {
      await reservation.reservation.release();
    };

    try {
      // 4. Cost ceiling (explicitly enabled only; default disabled).
      if (config.costCeiling.enabled) {
        const spend = await deps.store.spendUnits(nowMs);
        if (spend >= config.costCeiling.monthlyLimitUnits) {
          await releaseForFailure();
          return incomplete("cost_ceiling");
        }
      }

      // 5. Provider call with handler-owned timeout: the deadline settles
      // via Promise.race even if the provider ignores the abort signal.
      // After the race settles, the pending provider promise gets a no-op
      // catch so its late settlement never becomes an unhandled rejection
      // — without ever swallowing a WINNING provider failure.
      const controller = new AbortController();
      let result;
      let analyzePromise: Promise<ProviderResult> | undefined;
      let deadlineTimer: NodeJS.Timeout | undefined;
      try {
        analyzePromise = deps.provider.analyze(digest, {
          timeoutMs: config.timeoutMs,
          signal: controller.signal,
        });
        const deadline = new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(() => {
            controller.abort(new Error("handler timeout"));
            reject(new ProviderFailure("timeout", "analysis deadline exceeded"));
          }, config.timeoutMs);
        });
        result = await Promise.race([analyzePromise, deadline]);
      } finally {
        // F2: clear the deadline timer on EVERY settled path (success,
        // provider failure, deadline itself) — no lingering 120 s timers,
        // no post-completion aborts, no delayed process exit.
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
        // Losing-side cleanup: if the deadline won, the provider promise
        // is still pending; attach a no-op catch (idempotent if settled).
        void analyzePromise?.catch(() => undefined);
      }

      // Final contract guard: regardless of which adapter is configured, the
      // response must never carry out-of-range scores or unresolvable
      // citations. (Bounded retry ownership stays in the provider adapter.)
      const validation = validateProviderResult(result, digest);
      if (!validation.ok) {
        await releaseForFailure();
        return incomplete("invalid_model_response");
      }

      // 6. Response assembly: principal total only when all five dimensions
      // are evaluable; weights fixed at 20% each (never silently changed).
      const byDimension = new Map(result.dimensions.map((d) => [d.dimension, d]));
      const ordered: DimensionScore[] = DIMENSIONS.map(
        (name) =>
          byDimension.get(name) ?? {
            dimension: name,
            evaluable: false,
            evidence: [],
            notes: "missing from provider response",
          },
      );
      const response: AnalyzeResponse = {
        schema: SCHEMA,
        outcome: "complete",
        // Exactly 5 by construction (DIMENSIONS.map); tuple-typed in contract.
        // SAFETY: `ordered` always has exactly DIMENSIONS.length === 5 elements,
        // one per rubric dimension in contract order — TypeScript cannot prove
        // a 5-tuple from Array.map, so the upcast asserts the runtime invariant.
        dimensions: ordered as unknown as AnalyzeResponse["dimensions"],
        confidenceNote: result.confidenceNote,
      };
      const allEvaluable = ordered.every((d) => d.evaluable);
      if (allEvaluable) {
        // Equal weights (20% each) from rubric@1 — deterministic, never
        // silently changed. Guarded assignment (total is defined at 5/5).
        const total = weightedTotal(ordered);
        if (total !== undefined) response.total = total;
      }

      // Success: quota slot stays consumed; concurrency slot released.
      // F3: the spend write is OPTIONAL metadata (operator ceiling accounting,
      // default-disabled ceiling): a store failure here must NEVER refund the
      // consumed quota or turn the completed valid result into a retry error.
      // LIMITATION (documented honestly): if this write fails, the monthly
      // ceiling under-counts by one unit — accounting skew only, never a
      // correctness or safety issue (never a fabricated score/paid fallback).
      await reservation.reservation.releaseConcurrency();
      try {
        await deps.store.addSpend(1, nowMs);
      } catch {
        // Metadata-only best effort; see LIMITATION note above.
      }
      return response;
    } catch (error) {
      await releaseForFailure();
      if (error instanceof ProviderFailure) {
        return incomplete(error.code, error.retryAfterSeconds);
      }
      return incomplete("provider_unavailable");
    }
  };

  return { handle };
}
