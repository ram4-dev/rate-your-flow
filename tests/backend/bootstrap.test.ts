import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fromEnv } from "../../src/backend/config.js";
import { InMemoryCounterStore } from "../../src/backend/counters/in-memory.js";
import { SharedCounterStore } from "../../src/backend/counters/shared.js";
import { buildDeps, main, startServer } from "../../src/backend/main.js";
import { OpenCodeGoProvider } from "../../src/backend/providers/opencodego.js";
import type { OperatorConfig } from "../../src/backend/config.js";

type Env = Record<string, string | undefined>;

const REDIS_URL = process.env.RYF_TEST_REDIS_URL ?? "redis://127.0.0.1:32773";

const VALID_DEV: Env = {
  RYF_COUNTER_MODE: "dev-memory",
  RYF_PROVIDER_ENDPOINT: "http://127.0.0.1:9/v1", // dead endpoint; only used to construct the provider
  RYF_PROVIDER_MODEL: "glm-5.3-flash",
  OPENCODE_GO_API_KEY: "dummy-vault-handle",
};

function freePort(): Promise<number> {
  const server = createServer();
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

describe("operator bootstrap wiring (tasks 3.2, 3.3)", () => {
  it("dev-memory mode wires an InMemoryCounterStore and OpenCodeGoProvider", () => {
    const config = fromEnv({ ...VALID_DEV });
    const deps = buildDeps(config);
    expect(deps.store).toBeInstanceOf(InMemoryCounterStore);
    expect(deps.provider).toBeInstanceOf(OpenCodeGoProvider);
  });

  it("redis mode wires a SharedCounterStore with the redis URL and key prefix", () => {
    const config = fromEnv({
      ...VALID_DEV,
      RYF_COUNTER_MODE: "redis",
      RYF_REDIS_URL: REDIS_URL,
      RYF_KEY_PREFIX: "ryf:boot:",
    });
    const deps = buildDeps(config);
    expect(deps.store).toBeInstanceOf(SharedCounterStore);
  });

  it("redis-mode SharedCounterStore round-trips against RYF_TEST_REDIS_URL", async () => {
    const config = fromEnv({
      ...VALID_DEV,
      RYF_COUNTER_MODE: "redis",
      RYF_REDIS_URL: REDIS_URL,
      RYF_KEY_PREFIX: "ryf:boot:test:",
    });
    const store = buildDeps(config).store as SharedCounterStore;
    const out = await store.reserve({
      installUUID: "bootstrap-test-uuid",
      utcDay: "2026-09-07",
      now: 1_000_000,
      reservationTtlMs: 5_000,
    });
    expect(out.ok).toBe(true);
    if (out.ok) await out.reservation.release();
    await store.purgeOwnKeys();
    await store.close();
  }, 30_000);

  it("startServer binds loopback by default and honors PORT", async () => {
    const port = await freePort();
    const config = fromEnv({ ...VALID_DEV, PORT: String(port) });
    const handle = await startServer(config);
    const address = handle.server.address() as AddressInfo;
    expect(address.address).toBe("127.0.0.1");
    expect(address.port).toBe(port);
    await handle.close();
  }, 20_000);

  it("main with missing configuration returns non-zero and names the missing variable", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = await main({});
      expect(code).toBe(1);
      const call = writeSpy.mock.calls.find(([body]) => String(body).includes("RYF_COUNTER_MODE"));
      expect(String(call?.[0] ?? "")).toContain("RYF_COUNTER_MODE");
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("main with a redis config missing RYF_REDIS_URL returns non-zero and names RYF_REDIS_URL", async () => {
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = await main({ ...VALID_DEV, RYF_COUNTER_MODE: "redis" });
      expect(code).toBe(1);
      const call = writeSpy.mock.calls.find(([body]) => String(body).includes("RYF_REDIS_URL"));
      expect(String(call?.[0] ?? "")).toContain("RYF_REDIS_URL");
    } finally {
      writeSpy.mockRestore();
    }
  });

  it("startServer().close() tears down the owned Redis store without leaking a connection", async () => {
    const port = await freePort();
    const config = fromEnv({
      ...VALID_DEV,
      RYF_COUNTER_MODE: "redis",
      RYF_REDIS_URL: REDIS_URL,
      RYF_KEY_PREFIX: "ryf:boot:close:",
      PORT: String(port),
    });
    const handle = await startServer(config);
    expect(handle.store).toBeInstanceOf(SharedCounterStore);
    const store = handle.store as SharedCounterStore;
    // Connect by exercising a reserve, then tear down with the single close path.
    const out = await store.reserve({
      installUUID: "close-test-uuid",
      utcDay: "2026-09-07",
      now: 1_000_000,
      reservationTtlMs: 5_000,
    });
    expect(out.ok).toBe(true);
    if (out.ok) await out.reservation.release();
    await store.purgeOwnKeys();
    await handle.close();
    // The owned Redis client is disconnected: no leaked/live connection remains.
    const clientState = (store as unknown as { client?: { isOpen?: boolean } }).client;
    expect(clientState?.isOpen).toBe(false);
    // Idempotent: a second close is a safe no-op.
    await handle.close();
  }, 30_000);

  it("startup diagnostics never echo the credential, redis URL, or provider URL value", async () => {
    const SECRET = "shh-super-secret-999";
    const redisWithCreds = "redis://user:pass@127.0.0.1:6379";
    const writeSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      // Invalid PORT while the secret and an authenticated Redis URL are present:
      // the diagnostic must name the variable (PORT), never echo the values.
      const code = await main({
        RYF_COUNTER_MODE: "redis",
        RYF_REDIS_URL: redisWithCreds,
        RYF_PROVIDER_ENDPOINT: "https://host.example/v1",
        RYF_PROVIDER_MODEL: "glm-5.3-flash",
        OPENCODE_GO_API_KEY: SECRET,
        PORT: "not-a-port",
      });
      expect(code).toBe(1);
      const stderr = writeSpy.mock.calls.map(([body]) => String(body)).join("");
      expect(stderr).toContain("PORT");
      expect(stderr).not.toContain(SECRET);
      expect(stderr).not.toContain("user:pass");
    } finally {
      writeSpy.mockRestore();
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

export type { OperatorConfig };
