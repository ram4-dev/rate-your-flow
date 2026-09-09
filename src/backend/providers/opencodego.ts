/**
 * OpenCodeGoProvider — fully implemented OpenAI-compatible HTTP provider
 * adapter (design D4; GLM-5.3-Flash candidate).
 *
 * Contract (analysis-backend spec, "Real OpenAI-compatible provider adapter"):
 * - builds the outbound request from the public contract (OpenAI-compatible
 *   chat/completions body) with the auth header sourced ONLY from the
 *   injected server-side credential handle (vault-env-shaped; tests use a
 *   dummy value) — never from CLI/user config, never logged;
 * - validates the provider response schema and per-dimension citations
 *   (validateProviderResult) before producing a result;
 * - maps 429 → over_quota and 402 → payment_required with `retry-after`
 *   passthrough, never a paid fallback;
 * - maps malformed responses to invalid_model_response with ONE bounded
 *   retry (scoring design D7); connection failures → provider_unavailable;
 *   timeout aborts → timeout.
 * - Prompt content: full rubric v1 descriptors land in Phase 7; this adapter
 *   ships a minimal versioned default.
 */

import { randomUUID } from "node:crypto";
import { RYF_VERSION } from "../../shared/version.js";
import type { DimensionScore, DigestV1 } from "../../shared/contracts/index.js";
import {
  ProviderFailure,
  type AnalysisProvider,
  type ProviderOptions,
  type ProviderResult,
} from "../types.js";
import { validateProviderResult } from "./validate.js";
import { buildScoringPrompt } from "../prompt/template@1.js";

export interface OpenCodeGoProviderOptions {
  /** OpenAI-compatible base endpoint, e.g. https://host/v1 */
  endpoint: string;
  model: string;
  /** Server-side injected credential handle (vault-env-shaped). */
  credentialHandle: string;
}

/** Thrown when the model response is structurally invalid. */
class InvalidModelResponseError extends ProviderFailure {
  constructor(reason: string) {
    super("invalid_model_response", `invalid model response: ${reason}`);
  }
}

interface ParsedModelOutput {
  dimensions: DimensionScore[];
  confidenceNote?: string;
}

/** Chat-completions JSON body (OpenAI-compatible shape). */
interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

/**
 * Some OpenAI-compatible providers serialize an absent score as JSON null.
 * Accept that representation only for dimensions explicitly marked false;
 * every other score shape remains for the contract validator to reject.
 */
function normalizeNotEvaluableNullScores(dimensions: unknown[]): DimensionScore[] {
  return dimensions.map((dimension) => {
    if (
      dimension !== null &&
      typeof dimension === "object" &&
      (dimension as { evaluable?: unknown }).evaluable === false &&
      (dimension as { score?: unknown }).score === null
    ) {
      const { score: _score, ...withoutScore } = dimension as Record<string, unknown>;
      return withoutScore as unknown as DimensionScore;
    }
    return dimension as DimensionScore;
  });
}

export class OpenCodeGoProvider implements AnalysisProvider {
  readonly name = "opencodego";

  constructor(private readonly options: OpenCodeGoProviderOptions) {}

  async analyze(digest: DigestV1, options: ProviderOptions): Promise<ProviderResult> {
    // One random UUID per analysis, reused across this exchange's bounded
    // retries; distinct from the client install UUID (absent from the digest)
    // and from any server-side UUID.
    const session = randomUUID();
    // One bounded retry on invalid model responses (design D7); transport and
    // billing errors propagate immediately.
    for (let attempt = 0; ; attempt++) {
      let raw: string;
      try {
        raw = await this.#post(digest, options, session);
      } catch (error) {
        if (error instanceof ProviderFailure) throw error;
        if (options.signal?.aborted) throw new ProviderFailure("timeout", "provider call aborted");
        throw new ProviderFailure("provider_unavailable", String(error));
      }
      try {
        return this.#parse(raw, digest);
      } catch (error) {
        if (!(error instanceof InvalidModelResponseError)) throw error;
        if (attempt >= 1) throw error; // bounded: max 1 retry
      }
    }
  }

  /** One OpenAI-compatible chat/completions POST with abortable timeout. */
  async #post(digest: DigestV1, options: ProviderOptions, session: string): Promise<string> {
    const url = `${this.options.endpoint.replace(/\/+$/, "")}/chat/completions`;
    const messages = [
      { role: "system", content: buildScoringPrompt(digest).system },
      { role: "user", content: buildScoringPrompt(digest).user },
    ];
    const init: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.options.credentialHandle}`,
        // Own product identity per <https://opencode.ai/docs/go/>; never
        // impersonates another client.
        "user-agent": `rate-your-flow/${RYF_VERSION}`,
        "x-opencode-session": session,
      },
      body: JSON.stringify({
        model: this.options.model,
        messages,
        temperature: 0,
        ...(this.options.model === "deepseek-v4-flash"
          ? {
              thinking: { type: "disabled" },
              response_format: { type: "json_object" },
              max_tokens: 4096,
            }
          : {}),
      }),
    };
    // F4: compose BOTH the adapter's own deadline and a caller signal (if
    // present) — AbortSignal.any ensures the shorter deadline wins and the
    // caller's controller is never aborted by the adapter's own timer.
    const signals: AbortSignal[] = [AbortSignal.timeout(options.timeoutMs)];
    if (options.signal !== undefined) signals.push(options.signal);
    init.signal = signals.length === 1 ? signals[0]! : AbortSignal.any(signals);
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      if (init.signal?.aborted) {
        throw new ProviderFailure("timeout", "provider call timed out");
      }
      throw new ProviderFailure("provider_unavailable", String(error));
    }
    if (response.status === 429 || response.status === 402) {
      const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
      throw new ProviderFailure(
        response.status === 429 ? "over_quota" : "payment_required",
        `provider returned ${response.status}`,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      );
    }
    if (response.status !== 200) {
      throw new ProviderFailure(
        "provider_unavailable",
        `provider returned unexpected status ${response.status}`,
      );
    }
    return response.text();
  }

  /** Extract + validate the model output; throws InvalidModelResponseError. */
  #parse(raw: string, digest: DigestV1): ProviderResult {
    let completion: unknown;
    try {
      completion = JSON.parse(raw);
    } catch {
      throw new InvalidModelResponseError("body is not JSON");
    }
    const choices = (completion as ChatCompletionResponse).choices;
    const content = choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new InvalidModelResponseError("missing choices[0].message.content");
    }
    let output: unknown;
    try {
      output = JSON.parse(content);
    } catch {
      throw new InvalidModelResponseError("message.content is not JSON");
    }
    const dimensions: unknown = Array.isArray(output)
      ? output
      : (output as ParsedModelOutput | null)?.dimensions;
    if (!Array.isArray(dimensions)) {
      throw new InvalidModelResponseError("no dimensions array in model output");
    }
    const confidenceNote = Array.isArray(output)
      ? undefined
      : (output as ParsedModelOutput).confidenceNote;
    const normalizedDimensions = normalizeNotEvaluableNullScores(dimensions);
    const validation = validateProviderResult({ dimensions: normalizedDimensions, confidenceNote: confidenceNote ?? "" }, digest);
    if (!validation.ok) {
      throw new InvalidModelResponseError(validation.reason);
    }
    return {
      dimensions: normalizedDimensions,
      confidenceNote: confidenceNote ?? "descriptive confidence only; not a calibrated probability",
    };
  }
}
