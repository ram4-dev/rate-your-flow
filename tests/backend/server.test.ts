import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_BACKEND_CONFIG } from "../../src/backend/config.js";
import { InMemoryCounterStore } from "../../src/backend/counters/in-memory.js";
import { createBackendServer } from "../../src/backend/server.js";
import { HttpProviderStub } from "../../src/backend/providers/stub.js";
import type { createAnalysisHandler } from "../../src/backend/handler.js";
import type { DigestV1 } from "../../src/shared/contracts/index.js";

const DIGEST: DigestV1 = {
  schema: "digest@1",
  counters: { sessions: 1 },
  eventSequences: [{ sessionId: "s1", events: [{ line: 1, kind: "message" }] }],
  episodes: [],
  citedSnippets: [{ sessionId: "s1", line: 1, text: "evidence" }],
};

let server: Server;
let baseUrl = "";
let providerCalls = 0;

const deps = {
  store: new InMemoryCounterStore({ quotaPerDay: 3, concurrencyLimit: 1 }),
  provider: new HttpProviderStub({ mode: "ok" }),
  config: { ...DEFAULT_BACKEND_CONFIG, timeoutMs: 500, maxPayloadBytes: 2048 },
  now: () => 1_000_000,
};

beforeAll(async () => {
  // Spy on provider calls via Proxy.
  const realAnalyze = deps.provider.analyze.bind(deps.provider);
  deps.provider.analyze = ((...args: Parameters<typeof realAnalyze>) => {
    providerCalls += 1;
    return realAnalyze(...args);
  }) as typeof deps.provider.analyze;

  server = createBackendServer({ deps, handlerFactory: null as never });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function post(path: string, body: string): Promise<{ status: number; json: unknown }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return { status: response.status, json: (await response.json()) as unknown };
}

describe("backend HTTP server (analysis@1, Portless-compatible local dev)", () => {
  it("POST /analyze with a valid envelope => 200 complete response", async () => {
    const { status, json } = await post(
      "/analyze",
      JSON.stringify({ schema: "analysis@1", installUUID: "uuid-1", digest: DIGEST }),
    );
    expect(status).toBe(200);
    expect((json as { outcome?: string }).outcome).toBe("complete");
  });

  it("unknown route => 404 (non-contract route)", async () => {
    const response = await fetch(`${baseUrl}/nope`, { method: "POST", body: "{}" });
    expect(response.status).toBe(404);
  });

  it("GET /healthz => 200", async () => {
    const response = await fetch(`${baseUrl}/healthz`);
    expect(response.status).toBe(200);
  });

  it("oversized body rejected with envelope; provider never called", async () => {
    const before = providerCalls;
    const big = "x".repeat(4096);
    const { status, json } = await post(
      "/analyze",
      JSON.stringify({ schema: "analysis@1", installUUID: "u-big", digest: DIGEST, pad: big }),
    );
    expect(status).toBe(413);
    expect((json as { error?: { code?: string } }).error?.code).toBe("oversized_payload");
    expect(providerCalls).toBe(before);
  });

  it("graceful close: server.close resolves", async () => {
    const extra = createBackendServer({ deps, handlerFactory: null as never });
    await new Promise<void>((resolve) => extra.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => extra.close(() => resolve()));
    expect(true).toBe(true);
  });

  it("vercel-compatible entry delegates to the same handler", async () => {
    const { createVercelHandler } = await import("../../src/backend/vercel.js");
    const vercelServer: Server = createServer(
      createVercelHandler({ deps, handlerFactory: null as never }),
    );
    await new Promise<void>((resolve) => vercelServer.listen(0, "127.0.0.1", resolve));
    const port = (vercelServer.address() as AddressInfo).port;
    const response = await fetch(`http://127.0.0.1:${port}/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ schema: "analysis@1", installUUID: "uuid-v", digest: DIGEST }),
    });
    const json = (await response.json()) as { outcome?: string };
    expect(json.outcome).toBe("complete");
    await new Promise<void>((resolve) => vercelServer.close(() => resolve()));
  });
});

// Handler factory type is exercised in handler tests; the server accepts the
// same deps and builds its own handler when no handlerFactory is injected.
export type { ServerResponse, createAnalysisHandler };
