/**
 * consent@1 — versioned consent record.
 *
 * Persisted locally at `<config-dir>/ryf/consent.json`. Re-consent is required
 * when destination or scopeVersion changes; refusal means local-only mode.
 */

export const CONSENT_SCHEMA = "consent@1" as const;
export type ConsentSchema = typeof CONSENT_SCHEMA;

export type ConsentState = "consented" | "refused";

export interface ConsentRecord {
  version: ConsentSchema;
  state: ConsentState;
  /** The exact egress destination URL this consent applies to. */
  destination: string;
  /** Content-scope version consented to; scope change ⇒ re-consent. */
  scopeVersion: string;
  /** ISO-8601 UTC timestamp of the decision. */
  timestamp: string;
}
