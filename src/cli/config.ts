/**
 * Optional per-user client configuration and additive TLS trust setup.
 *
 * The file is intentionally narrow: it holds a service URL and, when needed,
 * a PEM CA path. It never carries credentials and it never records consent.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";

export const CLIENT_CONFIG_INVALID_CODE = "client_config_invalid";
export const CLIENT_CA_INVALID_CODE = "client_ca_invalid";

export const CLIENT_CONFIG_DIAGNOSTIC =
  "invalid client configuration: ~/.config/ryf/config.json must contain an endpoint URL and optional caFile PEM path";
export const CLIENT_CA_DIAGNOSTIC =
  "invalid client CA configuration: configured caFile must be a readable PEM certificate";

export interface ClientConfig {
  endpoint: string;
  caFile?: string;
}

export interface DefaultCertificateStore {
  getDefault(): string[];
  setDefault(certificates: string[]): void;
}

const nodeDefaultCertificateStore: DefaultCertificateStore = {
  getDefault: () => getCACertificates("default"),
  setDefault: (certificates) => setDefaultCACertificates(certificates),
};

export type ClientConfigLoad =
  | { kind: "absent" }
  | { kind: "config"; config: ClientConfig }
  | { kind: "invalid"; reason: string };

function configPath(home: string): string {
  return join(home, ".config", "ryf", "config.json");
}

/** Read the optional config without exposing its contents in diagnostics. */
export function loadClientConfig(home: string): ClientConfigLoad {
  const file = configPath(home);
  if (!existsSync(file)) {
    return { kind: "absent" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { kind: "invalid", reason: "config.json could not be read as JSON" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid", reason: "config.json must be an object" };
  }
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== "endpoint" && key !== "caFile")) {
    return { kind: "invalid", reason: "config.json contains unsupported keys" };
  }
  if (typeof value.endpoint !== "string" || value.endpoint.trim() === "") {
    return { kind: "invalid", reason: "config.json endpoint must be a non-empty string" };
  }
  if (
    value.caFile !== undefined &&
    (typeof value.caFile !== "string" || value.caFile.trim() === "")
  ) {
    return { kind: "invalid", reason: "config.json caFile must be a non-empty string" };
  }
  return {
    kind: "config",
    config: value.caFile === undefined ? { endpoint: value.endpoint } : { endpoint: value.endpoint, caFile: value.caFile },
  };
}

/**
 * Add an explicit configured CA to Node's current defaults for one request.
 * The returned callback restores the exact prior roots, preventing trust from
 * leaking to another in-process CLI invocation.
 */
export function configureEndpointTrust(
  config: ClientConfig | undefined,
  resolvedEndpoint: string,
  certificates: DefaultCertificateStore = nodeDefaultCertificateStore,
): () => void {
  if (config?.caFile === undefined || config.endpoint !== resolvedEndpoint) {
    return () => undefined;
  }

  let pem: string;
  try {
    pem = readFileSync(config.caFile, "utf8");
  } catch {
    throw new Error(`${CLIENT_CA_INVALID_CODE}: ${CLIENT_CA_DIAGNOSTIC}`);
  }
  if (!pem.includes("-----BEGIN CERTIFICATE-----")) {
    throw new Error(`${CLIENT_CA_INVALID_CODE}: ${CLIENT_CA_DIAGNOSTIC}`);
  }

  const original = certificates.getDefault();
  try {
    certificates.setDefault([...original, pem]);
  } catch {
    throw new Error(`${CLIENT_CA_INVALID_CODE}: ${CLIENT_CA_DIAGNOSTIC}`);
  }
  let restored = false;
  return () => {
    if (!restored) {
      certificates.setDefault(original);
      restored = true;
    }
  };
}
