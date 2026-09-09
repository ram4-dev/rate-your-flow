/**
 * Common backend types: CounterStore contract (design D3) and provider
 * abstractions. Types + failure mapping only.
 */

import type { DimensionScore, DigestV1, AnalysisErrorCode } from "../shared/contracts/index.js";

/** Options every provider receives; `credentialHandle` is server-side only. */
export interface ProviderOptions {
  timeoutMs: number;
  /** Abort signal wired to the handler's timeout; providers MUST honor it. */
  signal?: AbortSignal;
  /**
   * Server-side injected credential handle (vault-env-shaped). Tests use a
   * dummy value. MUST never appear in logs, errors, or the wire contract.
   */
  credentialHandle?: string;
}

/** Validated provider output; the handler assembles the analysis@1 response. */
export interface ProviderResult {
  dimensions: DimensionScore[];
  /** Descriptive only; never a calibrated probability. */
  confidenceNote: string;
}

/**
 * Typed provider failure mapped 1:1 onto the analysis@1 error envelope.
 * Providers throw this; the handler forwards it (plus release logic).
 */
export class ProviderFailure extends Error {
  readonly code: AnalysisErrorCode;
  readonly retryAfterSeconds?: number;

  constructor(code: AnalysisErrorCode, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "ProviderFailure";
    this.code = code;
    if (retryAfterSeconds !== undefined) this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** A successful atomic reserve: release on failure paths, never on success. */
export interface CounterReservation {
  /** Release the global concurrency slot (always on completion/failure). */
  releaseConcurrency(): Promise<void>;
  /** Release the per-install daily quota slot (failure paths only). */
  releaseQuota(): Promise<void>;
  /** Release both (failure paths). */
  release(): Promise<void>;
}

export type ReserveOutcome =
  { ok: true; reservation: CounterReservation } | { ok: false; reason: "quota" | "concurrency" };

/**
 * Atomic counter store contract (design D3): reserve quota+concurrency in a
 * single atomic op; release on error/timeout/abort (no leaked reservations);
 * TTL on counters; metadata only — never digest content.
 */
export interface CounterStore {
  reserve(input: ReserveInput): Promise<ReserveOutcome>;
  /** Current monthly spend units (cost ceiling check; metadata only). */
  spendUnits(now: number): Promise<number>;
  /** Record spend units against the monthly bucket. */
  addSpend(units: number, now: number): Promise<void>;
}

export interface ReserveInput {
  installUUID: string;
  /** UTC calendar day string (quota bucket key). */
  utcDay: string;
  /** Epoch ms; injected for determinism in tests. */
  now: number;
  /** TTL for the concurrency reservation (timeout + slack). */
  reservationTtlMs: number;
}

export interface AnalysisProvider {
  readonly name: string;
  analyze(digest: DigestV1, options: ProviderOptions): Promise<ProviderResult>;
}
