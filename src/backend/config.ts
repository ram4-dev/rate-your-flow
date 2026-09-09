/**
 * Backend operator configuration (Phase 6, tasks 6.5).
 *
 * All operator values are proposals per design (Operator-Configurable Values):
 * quota 3/day (UTC day boundary), 1 concurrent analysis, 120 s timeout
 * (injectable for tests — tests override, never the default), payload size
 * guard, and a monthly cost ceiling that DEFAULTS TO DISABLED (no monthly USD
 * budget is imposed; when explicitly enabled and tripped the handler degrades
 * with an explicit notice and makes no provider call).
 */

export interface BackendConfig {
  quotaPerDay: number;
  concurrencyLimit: number;
  timeoutMs: number;
  /** Host/payload guard: oversized payloads are rejected before any provider call. */
  maxPayloadBytes: number;
  costCeiling: { enabled: boolean; monthlyLimitUnits: number };
}

export const DEFAULT_BACKEND_CONFIG: BackendConfig = {
  quotaPerDay: 3,
  concurrencyLimit: 1,
  timeoutMs: 120_000,
  maxPayloadBytes: 4_500_000,
  costCeiling: { enabled: false, monthlyLimitUnits: 0 },
};

/** UTC calendar day string for an epoch-ms instant (quota bucket key). */
export function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Milliseconds from `nowMs` until the next UTC midnight (quota TTL). */
export function utcMsUntilNextDay(nowMs: number): number {
  const now = new Date(nowMs);
  const nextMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
  const gap = nextMidnight - nowMs;
  return gap > 0 ? gap : 24 * 60 * 60 * 1000;
}

/**
 * Operator-visible config parsed from the environment (design D8, Unit C
 * task 3.1). The bootstrap converts this into injected deps. The default
 * bind is secure loopback; binding a non-loopback host requires an explicit
 * `RYF_BIND_HOST`. A missing provider endpoint or counter mode is a config
 * diagnostic (named variable), distinct from a runtime connection failure.
 */
export interface OperatorConfig {
  /** HTTP listen port (default `DEFAULT_OPERATOR_PORT`). */
  port: number;
  /** Bind host (default loopback `127.0.0.1`). */
  bindHost: string;
  /** Explicit counter mode; never inferred. */
  counterMode: "dev-memory" | "redis";
  /** Redis URL, present only when `counterMode === "redis"`. */
  redisUrl?: string;
  /** Unique key prefix for the Redis store. */
  redisKeyPrefix: string;
  /** OpenAI-compatible provider base endpoint (e.g. https://host/v1). */
  providerEndpoint: string;
  /** Provider model id. */
  providerModel: string;
  /** Name of the env var the credential was read from (server-side only). */
  credentialEnvName: string;
  /**
   * Server-side credential handle (vault-env-shaped). NEVER logged, echoed,
   * or placed on the wire; passed straight through to the provider.
   */
  credentialHandle: string;
}

/** Startup config diagnostic carrying the offending env variable name. */
export class BackendConfigError extends Error {
  readonly variable: string;

  constructor(variable: string, message: string) {
    super(message);
    this.name = "BackendConfigError";
    this.variable = variable;
  }
}

/** Default operator listen port (loopback-scoped). */
export const DEFAULT_OPERATOR_PORT = 8787;
/** Secure loopback bind host; a non-loopback bind requires explicit config. */
export const DEFAULT_BIND_HOST = "127.0.0.1";
/** Default Redis key prefix. */
export const DEFAULT_KEY_PREFIX = "ryf:";

/**
 * Validate an operator provider endpoint: absolute http(s), a hostname, and
 * NO embedded userinfo (`user:pass@`). Returns a reason string or undefined.
 */
function endpointUrlError(candidate: string): string | undefined {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return "must be an absolute http(s) URL";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "must use the http(s) scheme";
  }
  if (url.hostname === "") {
    return "must have a hostname";
  }
  if (url.username !== "" || url.password !== "") {
    return "must not contain embedded credentials (user:pass@)";
  }
  return undefined;
}

/**
 * Parse + validate operator configuration from an env-shaped record.
 * Required values are validated with named-variable diagnostics (forwarded
 * to the bootstrap, which exits non-zero without opening a socket). The
 * credential VALUE is never included in any diagnostic; only its env name.
 */
export function fromEnv(env: Record<string, string | undefined>): OperatorConfig {
  let port = DEFAULT_OPERATOR_PORT;
  const portRaw = env.PORT;
  if (portRaw !== undefined && portRaw !== "") {
    port = Number(portRaw);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new BackendConfigError("PORT", "PORT must be an integer in 1..65535");
    }
  }

  const bindHost =
    env.RYF_BIND_HOST !== undefined && env.RYF_BIND_HOST !== ""
      ? env.RYF_BIND_HOST
      : DEFAULT_BIND_HOST;

  const counterMode = env.RYF_COUNTER_MODE;
  if (counterMode !== "dev-memory" && counterMode !== "redis") {
    throw new BackendConfigError(
      "RYF_COUNTER_MODE",
      "RYF_COUNTER_MODE is required; set RYF_COUNTER_MODE=dev-memory or RYF_COUNTER_MODE=redis",
    );
  }

  let redisUrl: string | undefined;
  let redisKeyPrefix = DEFAULT_KEY_PREFIX;
  if (counterMode === "redis") {
    const raw = env.RYF_REDIS_URL;
    if (raw === undefined || raw === "") {
      throw new BackendConfigError(
        "RYF_REDIS_URL",
        "RYF_REDIS_URL is required when RYF_COUNTER_MODE=redis",
      );
    }
    redisUrl = raw;
    if (env.RYF_KEY_PREFIX !== undefined && env.RYF_KEY_PREFIX !== "") {
      redisKeyPrefix = env.RYF_KEY_PREFIX;
    }
  }

  const providerEndpoint = env.RYF_PROVIDER_ENDPOINT;
  if (providerEndpoint === undefined || providerEndpoint === "") {
    throw new BackendConfigError("RYF_PROVIDER_ENDPOINT", "RYF_PROVIDER_ENDPOINT is required");
  }
  const endpointError = endpointUrlError(providerEndpoint);
  if (endpointError !== undefined) {
    throw new BackendConfigError("RYF_PROVIDER_ENDPOINT", `RYF_PROVIDER_ENDPOINT ${endpointError}`);
  }

  const providerModel = env.RYF_PROVIDER_MODEL;
  if (providerModel === undefined || providerModel === "") {
    throw new BackendConfigError("RYF_PROVIDER_MODEL", "RYF_PROVIDER_MODEL is required");
  }

  const credentialEnvName =
    env.RYF_CREDENTIAL_ENV !== undefined && env.RYF_CREDENTIAL_ENV !== ""
      ? env.RYF_CREDENTIAL_ENV
      : "OPENCODE_GO_API_KEY";
  const credentialHandle = env[credentialEnvName];
  if (credentialHandle === undefined || credentialHandle === "") {
    throw new BackendConfigError(
      credentialEnvName,
      `${credentialEnvName} is required (server-side credential handle)`,
    );
  }

  return {
    port,
    bindHost,
    counterMode,
    ...(redisUrl !== undefined ? { redisUrl } : {}),
    redisKeyPrefix,
    providerEndpoint,
    providerModel,
    credentialEnvName,
    credentialHandle,
  };
}
