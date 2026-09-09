/**
 * Consent state machine (Phase 5, tasks 5.1/5.2; consent-privacy spec).
 *
 * Versioned `consent@1` record persisted per HOME at
 * `<config-dir>/ryf/consent.json`. State transitions:
 * - absent → prompt required (first use, with digest preview).
 * - consented(destination, scopeVersion) remembered → no re-prompt for the
 *   same destination + scope.
 * - destination OR scope change → re-prompt (re-consent).
 * - refused → local-only mode; no egress until explicit re-consent.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";

export interface ConsentRecord {
  version: "consent@1";
  state: "consented" | "refused";
  destination: string;
  scopeVersion: number;
  timestamp: string;
}

/** Config directory root for a HOME (POSIX: $HOME/.config/ryf). */
function ryfDirFor(home: string): string {
  return join(home, ".config", "ryf");
}

/** Absolute consent.json path for a HOME. */
export function consentFilePathFor(home: string): string {
  return join(ryfDirFor(home), "consent.json");
}

/** Validate the full consent record shape (root U4 review: malformed or
 * unknown-state records must NEVER authorize egress). */
function isValidConsent(value: unknown): value is ConsentRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const r = value as Partial<ConsentRecord>;
  return (
    r.version === "consent@1" &&
    (r.state === "consented" || r.state === "refused") &&
    typeof r.destination === "string" &&
    r.destination !== "" &&
    typeof r.scopeVersion === "number" &&
    Number.isInteger(r.scopeVersion) &&
    r.scopeVersion > 0 &&
    typeof r.timestamp === "string" &&
    r.timestamp !== ""
  );
}

/** Load the stored consent record; malformed/unknown-state → absent. */
export function loadConsent(home: string): ConsentRecord | undefined {
  const file = consentFilePathFor(home);
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return isValidConsent(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Persist the consent record with owner-only permissions (0600). */
export function saveConsent(home: string, record: ConsentRecord): void {
  const dir = ryfDirFor(home);
  mkdirSync(dir, { recursive: true });
  writeFileSync(consentFilePathFor(home), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  chmodSync(consentFilePathFor(home), 0o600);
}

/**
 * Whether the consent prompt must be (re-)shown before egress:
 * - no stored record → true (first use);
 * - refused record → true (refusal blocks egress until re-consent);
 * - consented but destination or scopeVersion differs → true (re-consent);
 * - consented for the same destination + scope → false.
 */
export function shouldRePrompt(home: string, destination: string, scopeVersion = 1): boolean {
  const stored = loadConsent(home);
  if (stored === undefined) {
    return true;
  }
  if (stored.state === "refused") {
    return true;
  }
  return stored.destination !== destination || stored.scopeVersion !== scopeVersion;
}
