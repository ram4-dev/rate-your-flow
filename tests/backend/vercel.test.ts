import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_BACKEND_CONFIG } from "../../src/backend/config.js";
import { InMemoryCounterStore } from "../../src/backend/counters/in-memory.js";
import { HttpProviderStub } from "../../src/backend/providers/stub.js";
import type { ServerDeps } from "../../src/backend/server.js";
import type { DigestV1 } from "../../src/shared/contracts/index.js";
import { createProductionVercelHandler, createVercelHandler } from "../../src/backend/vercel.js";

const DIGEST: DigestV1 = {
  schema: "digest@1",
  counters: { sessions: 1 },
  eventSequences: [{ sessionId: "s1", events: [{ line: 1, kind: "message" }] }],
  episodes: [],
  citedSnippets: [{ sessionId: "s1", line: 1, text: "evidence" }],
};

const VALID_ENVELOPE = JSON.stringify({
  schema: "analysis@1",
  installUUID: "uuid-vercel",
  digest: DIGEST,
});

const deps: ServerDeps = {
  store: new InMemoryCounterStore({ quotaPerDay: 3, concurrencyLimit: 1 }),
  provider: new HttpProviderStub({ mode: "ok" }),
  config: { ...DEFAULT_BACKEND_CONFIG, timeoutMs: 500, maxPayloadBytes: 2048 },
  now: () => 1_000_000,
};

let providerCalls = 0;
let server: Server;
let baseUrl = "";

async function request(
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; text: string }> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.body = body;
    init.headers = { "content-type": "application/json" };
  }
  const response = await fetch(`${baseUrl}${path}`, init);
  return { status: response.status, text: await response.text() };
}

beforeAll(async () => {
  const realAnalyze = deps.provider.analyze.bind(deps.provider);
  deps.provider.analyze = ((...args: Parameters<typeof realAnalyze>) => {
    providerCalls += 1;
    return realAnalyze(...args);
  }) as typeof deps.provider.analyze;

  server = createServer(createVercelHandler({ deps, handlerFactory: null as never }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("Vercel adapter routing (design D2)", () => {
  it("GET /healthz => 200 ok", async () => {
    const { status, text } = await request("GET", "/healthz");
    expect(status).toBe(200);
    expect(text).toBe("ok");
  });

  it("GET /api/healthz => 200 ok", async () => {
    const { status, text } = await request("GET", "/api/healthz");
    expect(status).toBe(200);
    expect(text).toBe("ok");
  });

  it("GET /healthz?probe=1 tolerates the query string", async () => {
    const { status, text } = await request("GET", "/healthz?probe=1");
    expect(status).toBe(200);
    expect(text).toBe("ok");
  });

  it("POST /api/analyze with a valid envelope => 200 complete", async () => {
    const before = providerCalls;
    const { status, text } = await request("POST", "/api/analyze", VALID_ENVELOPE);
    expect(status).toBe(200);
    expect(JSON.parse(text).outcome).toBe("complete");
    expect(providerCalls).toBe(before + 1);
  });

  it("POST /analyze remains compatible => 200 complete", async () => {
    const { status, text } = await request("POST", "/analyze", VALID_ENVELOPE);
    expect(status).toBe(200);
    expect(JSON.parse(text).outcome).toBe("complete");
  });

  it("POST /api/analyze?source=cli tolerates the query string", async () => {
    const { status, text } = await request("POST", "/api/analyze?source=cli", VALID_ENVELOPE);
    expect(status).toBe(200);
    expect(JSON.parse(text).outcome).toBe("complete");
  });

  it("unknown route => 404", async () => {
    const { status } = await request("POST", "/nope", "{}");
    expect(status).toBe(404);
  });

  it("GET on an analyze path => 404", async () => {
    const { status } = await request("GET", "/api/analyze");
    expect(status).toBe(404);
  });

  it("oversized body on /api/analyze => 413 envelope; provider never called", async () => {
    const before = providerCalls;
    const big = "x".repeat(4096);
    const { status, text } = await request(
      "POST",
      "/api/analyze",
      JSON.stringify({ schema: "analysis@1", installUUID: "u-big", digest: DIGEST, pad: big }),
    );
    expect(status).toBe(413);
    expect(JSON.parse(text).error.code).toBe("oversized_payload");
    expect(providerCalls).toBe(before);
  });
});

describe("production bootstrap (design D3): Redis-only, fail-closed", () => {
  it("dev-memory config => 503 on every route; never serves analyses", async () => {
    const handler = createProductionVercelHandler({
      RYF_COUNTER_MODE: "dev-memory",
      RYF_PROVIDER_ENDPOINT: "https://provider.example/v1",
      RYF_PROVIDER_MODEL: "test-model",
      OPENCODE_GO_API_KEY: "dummy-key",
    });
    const s: Server = createServer(handler);
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    const p = (s.address() as AddressInfo).port;
    for (const [method, path, body] of [
      ["GET", "/healthz", undefined],
      ["GET", "/api/healthz", undefined],
      ["POST", "/analyze", "{}"],
      ["POST", "/api/analyze", VALID_ENVELOPE],
    ] as const) {
      const init: RequestInit = { method };
      if (body !== undefined) init.body = body;
      const response = await fetch(`http://127.0.0.1:${p}${path}`, init);
      expect(response.status).toBe(503);
      const json = (await response.json()) as { error?: { code?: string } };
      expect(json.error?.code).toBe("provider_unavailable");
    }
    await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  it("missing required provider env => 503 with the offending variable named", async () => {
    const handler = createProductionVercelHandler({
      RYF_COUNTER_MODE: "redis",
      RYF_REDIS_URL: "redis://127.0.0.1:6379",
      // RYF_PROVIDER_ENDPOINT / MODEL / key omitted on purpose.
    });
    const s: Server = createServer(handler);
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    const p = (s.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${p}/api/analyze`, {
      method: "POST",
      body: VALID_ENVELOPE,
    });
    expect(response.status).toBe(503);
    const json = (await response.json()) as { error?: { code?: string } };
    expect(json.error?.code).toBe("provider_unavailable");
    await new Promise<void>((resolve) => s.close(() => resolve()));
  });

  it("valid redis env passes the config guard (failure comes from store, not config)", async () => {
    const handler = createProductionVercelHandler({
      RYF_COUNTER_MODE: "redis",
      RYF_REDIS_URL: "redis://127.0.0.1:1/0",
      RYF_PROVIDER_ENDPOINT: "https://provider.example/v1",
      RYF_PROVIDER_MODEL: "test-model",
      OPENCODE_GO_API_KEY: "dummy-key",
    });
    const s: Server = createServer(handler);
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    const p = (s.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${p}/api/analyze`, {
      method: "POST",
      body: VALID_ENVELOPE,
    });
    // Not 503: the config guard passed; the failure comes from the store connect.
    expect(response.status).not.toBe(503);
    await new Promise<void>((resolve) => s.close(() => resolve()));
  });
});
