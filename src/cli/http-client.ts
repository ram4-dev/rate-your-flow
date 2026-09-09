/**
 * HTTP client for analysis@1 (Phase 5, tasks 5.3/5.4 + root transport fixes).
 *
 * Contract:
 * - Single egress attempt; NEVER follows redirects (redirect:"manual"; any
 *   3xx ⇒ endpoint_redirected, body cancelled, no second egress).
 * - The abort timer covers the ENTIRE exchange — fetch, status handling, and
 *   body read — and is cleared in ONE outer finally on every branch (root
 *   transport fix: early returns previously leaked the timer, keeping the
 *   child process alive for the full timeout).
 * - 429 → over_quota + retry-after; 402 → payment_required + retry-after;
 *   413 → oversized_payload; ≥500 → provider_unavailable; other non-OK →
 *   invalid_model_response (status number only in detail); unreachable →
 *   endpoint_unreachable. Never a paid fallback, never a retry.
 * - Parse-error details are FIXED phrases (never echo server content).
 */

import type { DigestV1 } from "../shared/contracts/digest@1.js";

const DEFAULT_TIMEOUT_MS = 120_000;

export type AnalysisErrorCode =
  | "over_quota"
  | "payment_required"
  | "timeout"
  | "quota_exhausted"
  | "cost_ceiling"
  | "oversized_payload"
  | "endpoint_unreachable"
  | "endpoint_redirected"
  | "provider_unavailable"
  | "invalid_model_response";

export type AnalysisResult =
  | { ok: true; body: unknown }
  | { ok: false; error: { code: AnalysisErrorCode; retryAfterSeconds?: number; detail?: string } };

export interface PostAnalysisOptions {
  /** Injectable timeout in ms (default 120_000). */
  timeoutMs?: number;
  /** Injectable fetch (tests/other transports). Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value.trim() === "") {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/** Best-effort body cancellation so error/refused responses never dangle. */
function cancelBody(response: Response): void {
  response.body?.cancel().catch(() => {
    // cancellation of an already-consumed/closed body is a no-op
  });
}

/**
 * POST the digest to the analysis endpoint. Single egress attempt; redirects
 * are never followed; the abort timer spans the whole exchange.
 */
export async function postAnalysis(
  endpoint: string,
  digest: DigestV1,
  installUUID: string,
  options: PostAnalysisOptions = {},
): Promise<AnalysisResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;
  const target = `${endpoint.replace(/\/$/, "")}/analyze`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await doFetch(target, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ schema: "analysis@1", installUUID, digest }),
        redirect: "manual", // never follow redirects: 3xx comes back intact
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        return { ok: false, error: { code: "timeout" } };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: { code: "endpoint_unreachable", detail: message } };
    }

    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    let result: AnalysisResult | undefined;
    if (response.status === 429) {
      result = {
        ok: false,
        error:
          retryAfter === undefined
            ? { code: "over_quota" }
            : { code: "over_quota", retryAfterSeconds: retryAfter },
      };
    } else if (response.status === 402) {
      result = {
        ok: false,
        error:
          retryAfter === undefined
            ? { code: "payment_required" }
            : { code: "payment_required", retryAfterSeconds: retryAfter },
      };
    } else if (response.status === 413) {
      result = { ok: false, error: { code: "oversized_payload" } };
    } else if (response.status >= 500) {
      result = { ok: false, error: { code: "provider_unavailable" } };
    } else if (response.status >= 300 && response.status < 400) {
      // Redirect refused: end egress, defined error, no second attempt.
      result = { ok: false, error: { code: "endpoint_redirected" } };
    } else if (!response.ok) {
      result = {
        ok: false,
        error: { code: "invalid_model_response", detail: `unexpected status ${response.status}` },
      };
    } else {
      let body: unknown;
      let parseFailure: AnalysisResult | undefined;
      try {
        body = (await response.json()) as unknown;
      } catch (error) {
        if (controller.signal.aborted) {
          parseFailure = { ok: false, error: { code: "timeout" } };
        } else {
          // Fixed-phrase detail: never echo malformed server content.
          void error;
          parseFailure = {
            ok: false,
            error: { code: "invalid_model_response", detail: "response body was not valid JSON" },
          };
        }
      }
      if (parseFailure !== undefined) {
        return parseFailure; // finally clears the timer
      }
      return { ok: true, body }; // finally clears the timer
    }
    if (result !== undefined && !result.ok) {
      // non-ok result: cancel the (unread) body so nothing dangles
      cancelBody(response);
    }
    return result as AnalysisResult;
  } finally {
    // ONE clear point for EVERY branch (root transport fix).
    clearTimeout(timer);
  }
}
