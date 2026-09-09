/**
 * digest@1 — versioned digest contract.
 *
 * The digest is the bounded, redacted summary the CLI sends to the backend.
 * Budget and sampling constants live here so CLI and backend can never drift.
 */

export const DIGEST_SCHEMA = "digest@1" as const;
export type DigestSchema = typeof DIGEST_SCHEMA;

/** Shipped default digest size budget: 48 KiB UTF-8 of useful content. */
export const DIGEST_DEFAULT_BUDGET_BYTES = 48 * 1024;

/** Deterministic latest-activity sampling cap: at most 50 sessions per digest. */
export const DIGEST_MAX_SESSIONS = 50 as const;

/** Local metrics window (record-timestamp based): 90 days. */
export const DIGEST_WINDOW_DAYS = 90 as const;

/** Named local counters (session/episode/tool-call counts). Values only. */
export type DigestCounters = Record<string, number>;

/** A single event reference within a session: source line + coarse kind. */
export interface DigestEvent {
  line: number;
  kind: string;
  /** ISO-8601 UTC timestamp, normalized (only field allowed to vary between runs). */
  ts?: string;
}

/** Per-session event sequence, by source line. */
export interface DigestEventSequence {
  sessionId: string;
  events: DigestEvent[];
}

/** A reconstructed working episode within one session. */
export interface DigestEpisode {
  sessionId: string;
  startLine: number;
  endLine: number;
  summary: string;
}

/** A cited snippet anchored to its exact session line. */
export interface CitedSnippet {
  sessionId: string;
  line: number;
  text: string;
}

/** The full versioned digest payload. Budget-bounded; redacted before finalize. */
export interface DigestV1 {
  schema: DigestSchema;
  counters: DigestCounters;
  eventSequences: DigestEventSequence[];
  episodes: DigestEpisode[];
  citedSnippets: CitedSnippet[];
}
