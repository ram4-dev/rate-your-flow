/**
 * Analysis endpoint resolution (progress-live Unit A, tasks 1.2–1.5).
 *
 * Precedence (spec): `--endpoint` flag > `RYF_ENDPOINT` env > persisted
 * client config > previously consented destination > none.
 *
 * Validation: the resolved candidate MUST be an absolute http(s) URL with a
 * hostname. URLs with embedded userinfo (`user:pass@`) and non-http(s) schemes
 * are rejected with a distinct invalid-endpoint diagnostic. Absence of any
 * endpoint is a distinct missing-configuration diagnostic — never conflated
 * with `endpoint_unreachable` (a runtime connection failure) and never filled
 * with a fabricated default public endpoint.
 */

import {
  CLIENT_CONFIG_DIAGNOSTIC,
  CLIENT_CONFIG_INVALID_CODE,
  loadClientConfig,
  type ClientConfig,
} from "./config.js";
import { loadConsent } from "./consent.js";

/**
 * Stable CLI-side incomplete-outcome codes (NOT part of the backend
 * ANALYSIS_ERROR_CODES envelope; these are CLI-local diagnostics).
 * Exact public tokens — do not rename without a coordinated change.
 */
export const ENDPOINT_NOT_CONFIGURED_CODE = "endpoint_not_configured";
export const ENDPOINT_INVALID_CODE = "endpoint_invalid";
export { CLIENT_CONFIG_INVALID_CODE };

export type EndpointResolution =
  | { kind: "endpoint"; endpoint: string; clientConfig?: ClientConfig }
  | { kind: "missing"; code: typeof ENDPOINT_NOT_CONFIGURED_CODE }
  | { kind: "invalid"; code: typeof ENDPOINT_INVALID_CODE; reason: string }
  | { kind: "config-invalid"; code: typeof CLIENT_CONFIG_INVALID_CODE; reason: string };

/** Fixed missing-configuration diagnostic (distinct from connection failure). */
export const MISSING_ENDPOINT_DIAGNOSTIC =
  "no analysis endpoint configured: set RYF_ENDPOINT, create ~/.config/ryf/config.json, or run a consented --endpoint <url> analysis once; " +
  "the npm package is not yet published and no public service is deployed";

/** Fixed invalid-endpoint diagnostic. */
export const INVALID_ENDPOINT_DIAGNOSTIC =
  "invalid analysis endpoint: must be an absolute http(s) URL with a hostname and no embedded credentials (user:pass@)";
export { CLIENT_CONFIG_DIAGNOSTIC };

/** Previously consented destination (only a consented record authorizes reuse). */
function consentedDestination(home: string): string | undefined {
  const record = loadConsent(home);
  return record?.state === "consented" ? record.destination : undefined;
}

/** Validate a candidate endpoint URL; returns a reason when invalid, else undefined. */
export function validateEndpointUrl(candidate: string): string | undefined {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return "not an absolute http(s) URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "must use the http(s) scheme";
  }
  if (url.hostname === "") {
    return "missing hostname";
  }
  if (url.username !== "" || url.password !== "") {
    return "embedded user credentials are not allowed";
  }
  return undefined;
}

/** Resolve the endpoint with explicit precedence + validation. */
export function resolveEndpoint(
  flagValue: string | undefined,
  env: Record<string, string | undefined>,
  home: string,
): EndpointResolution {
  const explicit = flagValue ?? env["RYF_ENDPOINT"];
  if (explicit !== undefined) {
    const reason = validateEndpointUrl(explicit);
    if (reason !== undefined) {
      return { kind: "invalid", code: ENDPOINT_INVALID_CODE, reason };
    }
    // An override still gets the configured CA when it names exactly the
    // configured endpoint. A broken or different config cannot interfere
    // with an explicit destination and never grants it extra trust.
    const loaded = loadClientConfig(home);
    return loaded.kind === "config" && loaded.config.endpoint === explicit
      ? { kind: "endpoint", endpoint: explicit, clientConfig: loaded.config }
      : { kind: "endpoint", endpoint: explicit };
  }

  const loaded = loadClientConfig(home);
  if (loaded.kind === "invalid") {
    return { kind: "config-invalid", code: CLIENT_CONFIG_INVALID_CODE, reason: loaded.reason };
  }
  if (loaded.kind === "config") {
    const reason = validateEndpointUrl(loaded.config.endpoint);
    return reason === undefined
      ? { kind: "endpoint", endpoint: loaded.config.endpoint, clientConfig: loaded.config }
      : { kind: "config-invalid", code: CLIENT_CONFIG_INVALID_CODE, reason };
  }

  const candidate = consentedDestination(home);
  if (candidate === undefined) {
    return { kind: "missing", code: ENDPOINT_NOT_CONFIGURED_CODE };
  }
  const reason = validateEndpointUrl(candidate);
  if (reason !== undefined) {
    return { kind: "invalid", code: ENDPOINT_INVALID_CODE, reason };
  }
  return { kind: "endpoint", endpoint: candidate };
}
