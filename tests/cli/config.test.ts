import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configureEndpointTrust } from "../../src/cli/config.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ryf-config-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("configureEndpointTrust", () => {
  it("adds a configured PEM to Node's existing roots and restores them after the request", () => {
    const dir = tempDir();
    const caFile = join(dir, "fixture-ca.pem");
    const defaults = ["system-root"];
    let active = defaults;
    writeFileSync(caFile, "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n");

    const restore = configureEndpointTrust(
      { endpoint: "https://configured.example", caFile },
      "https://configured.example",
      {
        getDefault: () => active,
        setDefault: (certificates) => (active = certificates),
      },
    );
    expect(active).toEqual(["system-root", "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n"]);
    restore();
    expect(active).toEqual(defaults);
  });

  it("does not load a configured CA for an overriding endpoint", () => {
    const dir = tempDir();
    const caFile = join(dir, "fixture-ca.pem");
    const defaults = ["system-root"];
    let active = defaults;
    writeFileSync(caFile, "-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n");

    const restore = configureEndpointTrust(
      { endpoint: "https://configured.example", caFile },
      "https://override.example",
      {
        getDefault: () => active,
        setDefault: (certificates) => (active = certificates),
      },
    );
    expect(active).toEqual(defaults);
    restore();
  });

  it("rejects a missing configured CA with a named error that does not echo the path", () => {
    expect(() =>
      configureEndpointTrust(
        { endpoint: "https://configured.example", caFile: "/missing/private-ca.pem" },
        "https://configured.example",
      ),
    ).toThrow("client_ca_invalid");
  });
});
