import { describe, expect, it } from "vitest";
import {
  BackendConfigError,
  DEFAULT_BIND_HOST,
  DEFAULT_KEY_PREFIX,
  DEFAULT_OPERATOR_PORT,
  fromEnv,
} from "../../src/backend/config.js";

type Env = Record<string, string | undefined>;

const VALID: Env = {
  RYF_COUNTER_MODE: "dev-memory",
  RYF_PROVIDER_ENDPOINT: "https://host.example/v1",
  RYF_PROVIDER_MODEL: "glm-5.3-flash",
  OPENCODE_GO_API_KEY: "dummy-secret-handle",
};

function errMsg(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

describe("fromEnv (operator config parsing, task 3.1)", () => {
  it("parses a valid dev-memory config with loopback default bind and default port", () => {
    const config = fromEnv({ ...VALID });
    expect(config.counterMode).toBe("dev-memory");
    expect(config.bindHost).toBe(DEFAULT_BIND_HOST);
    expect(config.port).toBe(DEFAULT_OPERATOR_PORT);
    expect(config.providerEndpoint).toBe("https://host.example/v1");
    expect(config.providerModel).toBe("glm-5.3-flash");
    expect(config.credentialEnvName).toBe("OPENCODE_GO_API_KEY");
    expect(config.credentialHandle).toBe("dummy-secret-handle");
    expect(config.redisUrl).toBeUndefined();
  });

  it("honors PORT and RYF_BIND_HOST when provided", () => {
    const config = fromEnv({ ...VALID, PORT: "8123", RYF_BIND_HOST: "0.0.0.0" });
    expect(config.port).toBe(8123);
    expect(config.bindHost).toBe("0.0.0.0");
  });

  it("rejects invalid PORT values with a named diagnostic naming the variable", () => {
    expect(() => fromEnv({ ...VALID, PORT: "not-a-port" })).toThrowError(/PORT/);
    expect(() => fromEnv({ ...VALID, PORT: "0" })).toThrowError(/PORT/);
    expect(() => fromEnv({ ...VALID, PORT: "99999" })).toThrowError(/PORT/);
  });

  it("requires RYF_COUNTER_MODE (missing -> named diagnostic)", () => {
    const missing: Env = { ...VALID };
    delete missing.RYF_COUNTER_MODE;
    expect(errMsg(() => fromEnv(missing))).toMatch(/RYF_COUNTER_MODE/);
    expect(() => fromEnv(missing)).toThrowError(BackendConfigError);
  });

  it("rejects an invalid RYF_COUNTER_MODE value", () => {
    expect(errMsg(() => fromEnv({ ...VALID, RYF_COUNTER_MODE: "memory" }))).toMatch(
      /RYF_COUNTER_MODE/,
    );
  });

  it("redis mode requires RYF_REDIS_URL (missing -> named diagnostic)", () => {
    const env: Env = { ...VALID, RYF_COUNTER_MODE: "redis" };
    expect(errMsg(() => fromEnv(env))).toMatch(/RYF_REDIS_URL/);
  });

  it("redis mode accepts RYF_REDIS_URL and defaults the key prefix", () => {
    const config = fromEnv({
      ...VALID,
      RYF_COUNTER_MODE: "redis",
      RYF_REDIS_URL: "redis://127.0.0.1:6379",
    });
    expect(config.counterMode).toBe("redis");
    expect(config.redisUrl).toBe("redis://127.0.0.1:6379");
    expect(config.redisKeyPrefix).toBe(DEFAULT_KEY_PREFIX);
  });

  it("honors RYF_KEY_PREFIX in redis mode", () => {
    const config = fromEnv({
      ...VALID,
      RYF_COUNTER_MODE: "redis",
      RYF_REDIS_URL: "redis://127.0.0.1:6379",
      RYF_KEY_PREFIX: "ryf:prod:",
    });
    expect(config.redisKeyPrefix).toBe("ryf:prod:");
  });

  it("requires RYF_PROVIDER_ENDPOINT and RYF_PROVIDER_MODEL with named diagnostics", () => {
    const noEndpoint: Env = { ...VALID };
    delete noEndpoint.RYF_PROVIDER_ENDPOINT;
    expect(errMsg(() => fromEnv(noEndpoint))).toMatch(/RYF_PROVIDER_ENDPOINT/);
    const noModel: Env = { ...VALID };
    delete noModel.RYF_PROVIDER_MODEL;
    expect(errMsg(() => fromEnv(noModel))).toMatch(/RYF_PROVIDER_MODEL/);
  });

  it("rejects a malformed provider endpoint as a config diagnostic, not a runtime throw", () => {
    expect(errMsg(() => fromEnv({ ...VALID, RYF_PROVIDER_ENDPOINT: "not-a-url" }))).toMatch(
      /RYF_PROVIDER_ENDPOINT/,
    );
  });

  it("rejects embedded credentials in the provider endpoint and never echoes them", () => {
    const SECRET_PASSWORD = "sup3r-pass";
    const msg = errMsg(() =>
      fromEnv({
        ...VALID,
        RYF_PROVIDER_ENDPOINT: `https://user:${SECRET_PASSWORD}@host.example/v1`,
      }),
    );
    expect(msg).toMatch(/RYF_PROVIDER_ENDPOINT/);
    expect(msg).toMatch(/embedded credentials/);
    expect(msg).not.toContain(SECRET_PASSWORD);
  });

  it("requires the provider credential by the exact default env name OPENCODE_GO_API_KEY", () => {
    const missing: Env = { ...VALID };
    delete missing.OPENCODE_GO_API_KEY;
    expect(errMsg(() => fromEnv(missing))).toMatch(/OPENCODE_GO_API_KEY/);
  });

  it("overrides the credential env name via RYF_CREDENTIAL_ENV", () => {
    const config = fromEnv({
      ...VALID,
      RYF_CREDENTIAL_ENV: "MY_KEY",
      MY_KEY: "my-dummy-handle",
    });
    expect(config.credentialEnvName).toBe("MY_KEY");
    expect(config.credentialHandle).toBe("my-dummy-handle");
  });

  it("never includes the credential VALUE in any startup diagnostic", () => {
    const SECRET = "super-secret-value-12345";
    const cases: Env[] = [
      { ...VALID, OPENCODE_GO_API_KEY: SECRET, RYF_COUNTER_MODE: undefined },
      { ...VALID, OPENCODE_GO_API_KEY: SECRET, RYF_COUNTER_MODE: "redis" },
      { ...VALID, OPENCODE_GO_API_KEY: SECRET, PORT: "x" },
    ];
    for (const envCase of cases) {
      const msg = errMsg(() => fromEnv(envCase));
      expect(msg).toMatch(/RYF_|PORT/); // a named-variable diagnostic
      expect(msg).not.toContain(SECRET);
    }
  });
});
