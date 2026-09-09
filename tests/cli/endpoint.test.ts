/**
 * Unit A endpoint resolution (tasks 1.2–1.5, 1.3, 1.4).
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveEndpoint,
  validateEndpointUrl,
  ENDPOINT_NOT_CONFIGURED_CODE,
  ENDPOINT_INVALID_CODE,
  CLIENT_CONFIG_INVALID_CODE,
} from "../../src/cli/endpoint.js";

const homes: string[] = [];

function freshHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ryf-ep-"));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

function seedConsent(
  home: string,
  destination: string,
  state: "consented" | "refused" = "consented",
): void {
  const dir = join(home, ".config", "ryf");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "consent.json"),
    `${JSON.stringify({
      version: "consent@1",
      state,
      destination,
      scopeVersion: 1,
      timestamp: "2026-09-07T00:00:00Z",
    })}\n`,
  );
}

function seedClientConfig(home: string, value: unknown): void {
  const dir = join(home, ".config", "ryf");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    typeof value === "string" ? value : `${JSON.stringify(value)}\n`,
  );
}

describe("resolveEndpoint precedence (1.2)", () => {
  it("flag beats env", () => {
    const r = resolveEndpoint(
      "http://flag.example",
      { RYF_ENDPOINT: "http://env.example" },
      freshHome(),
    );
    expect(r.kind).toBe("endpoint");
    if (r.kind === "endpoint") {
      expect(r.endpoint).toBe("http://flag.example");
    }
  });

  it("env is honored when no flag", () => {
    const r = resolveEndpoint(undefined, { RYF_ENDPOINT: "http://env.example" }, freshHome());
    expect(r).toEqual({ kind: "endpoint", endpoint: "http://env.example" });
  });

  it("persisted configuration is selected before a consented destination", () => {
    const home = freshHome();
    seedConsent(home, "http://consent.example");
    seedClientConfig(home, { endpoint: "https://configured.example" });
    const r = resolveEndpoint(undefined, {}, home);
    expect(r.kind).toBe("endpoint");
    if (r.kind === "endpoint") {
      expect(r.endpoint).toBe("https://configured.example");
    }
  });

  it("flag and env override persisted configuration without reading it", () => {
    const home = freshHome();
    seedClientConfig(home, "{ not json");
    const flag = resolveEndpoint("https://flag.example", {}, home);
    const env = resolveEndpoint(undefined, { RYF_ENDPOINT: "https://env.example" }, home);
    expect(flag).toMatchObject({ kind: "endpoint", endpoint: "https://flag.example" });
    expect(env).toMatchObject({ kind: "endpoint", endpoint: "https://env.example" });
  });

  it("retains configured CA trust only when a flag or env resolves to the configured endpoint", () => {
    const home = freshHome();
    seedClientConfig(home, {
      endpoint: "https://configured.example",
      caFile: "/tmp/configured-ca.pem",
    });
    const flag = resolveEndpoint("https://configured.example", {}, home);
    const env = resolveEndpoint(undefined, { RYF_ENDPOINT: "https://configured.example" }, home);
    const override = resolveEndpoint("https://override.example", {}, home);
    expect(flag).toMatchObject({
      kind: "endpoint",
      endpoint: "https://configured.example",
      clientConfig: { caFile: "/tmp/configured-ca.pem" },
    });
    expect(env).toMatchObject({
      kind: "endpoint",
      endpoint: "https://configured.example",
      clientConfig: { caFile: "/tmp/configured-ca.pem" },
    });
    expect(override).not.toHaveProperty("clientConfig");
  });

  it("consented destination reused only when neither flag nor env", () => {
    const home = freshHome();
    seedConsent(home, "http://consent.example");
    const r = resolveEndpoint(undefined, {}, home);
    expect(r.kind).toBe("endpoint");
    if (r.kind === "endpoint") {
      expect(r.endpoint).toBe("http://consent.example");
    }
  });

  it("consented destination is NOT used when a flag is present", () => {
    const home = freshHome();
    seedConsent(home, "http://consent.example");
    const r = resolveEndpoint("http://flag.example", {}, home);
    expect(r.kind).toBe("endpoint");
    if (r.kind === "endpoint") {
      expect(r.endpoint).toBe("http://flag.example");
    }
  });

  it("consented destination is NOT used when env is present", () => {
    const home = freshHome();
    seedConsent(home, "http://consent.example");
    const r = resolveEndpoint(undefined, { RYF_ENDPOINT: "http://env.example" }, home);
    expect(r.kind).toBe("endpoint");
    if (r.kind === "endpoint") {
      expect(r.endpoint).toBe("http://env.example");
    }
  });

  it("no flag/env/consent => missing (stable code)", () => {
    const r = resolveEndpoint(undefined, {}, freshHome());
    expect(r).toEqual({ kind: "missing", code: ENDPOINT_NOT_CONFIGURED_CODE });
  });

  it("refused consent does NOT authorize destination reuse", () => {
    const home = freshHome();
    seedConsent(home, "http://consent.example", "refused");
    const r = resolveEndpoint(undefined, {}, home);
    expect(r).toEqual({ kind: "missing", code: ENDPOINT_NOT_CONFIGURED_CODE });
  });

  it("invalid candidate carries the stable invalid code", () => {
    const r = resolveEndpoint("ftp://x", {}, freshHome());
    expect(r.kind).toBe("invalid");
    if (r.kind === "invalid") {
      expect(r.code).toBe(ENDPOINT_INVALID_CODE);
    }
  });

  it.each(["{ not json", JSON.stringify({ endpoint: "ftp://configured.example" })])(
    "rejects malformed persisted configuration with a named diagnostic",
    (contents) => {
      const home = freshHome();
      seedClientConfig(home, contents);
      expect(resolveEndpoint(undefined, {}, home)).toMatchObject({
        kind: "config-invalid",
        code: CLIENT_CONFIG_INVALID_CODE,
      });
    },
  );
});

describe("validateEndpointUrl (1.3, 1.4)", () => {
  it("accepts absolute http(s) with a hostname", () => {
    expect(validateEndpointUrl("http://127.0.0.1:8080")).toBeUndefined();
    expect(validateEndpointUrl("https://example.com")).toBeUndefined();
    expect(validateEndpointUrl("https://example.com/path")).toBeUndefined();
  });

  it("rejects non-http(s) schemes (distinct invalid diagnostic)", () => {
    expect(validateEndpointUrl("ftp://x")).toBeDefined();
  });

  it("rejects embedded userinfo", () => {
    expect(validateEndpointUrl("https://user:pass@host")).toBeDefined();
    expect(validateEndpointUrl("http://user@host")).toBeDefined();
  });

  it("rejects URLs that are not absolute http(s) with a hostname", () => {
    expect(validateEndpointUrl("http://")).toBeDefined();
    expect(validateEndpointUrl("http:///")).toBeDefined();
  });
});
